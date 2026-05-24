const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth');
const prisma = require('../prisma');
const axios = require('axios');
const { getOrCreateUser } = require('../utils/users');

const DEFAULT_FREE_SCAN_CREDITS = Number(process.env.DEFAULT_FREE_SCAN_CREDITS || 25);
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'sundijason@gmail.com')
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);
const MIN_KNOWN_WASTE_CONFIDENCE = 0.08;
const MIN_UNKNOWN_WASTE_CONFIDENCE = 0.18;

const WASTE_BIN_MAP = {
  Plastic: 'Blue Bin',
  Glass: 'Green Bin',
  Paper: 'Paper Bin',
  Metal: 'Metal Bin',
  Compost: 'Compost',
  Electronics: 'E-Waste',
  Organic: 'Compost',
  Hazardous: 'Hazardous Waste',
  Default: 'General Waste'
};

const MATERIAL_MATCHERS = [
  { category: 'Hazardous', keywords: ['hazardous', 'chemical', 'paint', 'paint can', 'medicine', 'medical waste', 'toxic', 'poison', 'pesticide', 'aerosol', 'sanitary pad', 'diaper'] },
  { category: 'Electronics', keywords: ['electronic', 'electronics', 'e waste', 'ewaste', 'e-waste', 'battery', 'phone', 'mobile phone', 'keyboard', 'cable', 'charger', 'computer', 'laptop', 'circuit', 'remote', 'headphones'] },
  { category: 'Compost', keywords: ['compost', 'organic', 'food waste', 'leftover food', 'leaf', 'leaves', 'fruit', 'vegetable', 'banana peel', 'orange peel', 'peel', 'scraps', 'eggshell', 'tea bag', 'coffee grounds'] },
  { category: 'Glass', keywords: ['glass', 'glass bottle', 'glass jar', 'jar', 'vial'] },
  { category: 'Paper', keywords: ['paper', 'cardboard', 'carton', 'paper cup', 'paper bag', 'book', 'newspaper', 'magazine', 'envelope', 'folder', 'box'] },
  { category: 'Metal', keywords: ['metal', 'aluminium', 'aluminum', 'steel', 'tin can', 'soda can', 'metal can', 'food can', 'copper', 'wire', 'brass', 'iron', 'foil'] },
  { category: 'Plastic', keywords: ['plastic', 'plastic bottle', 'water bottle', 'soda bottle', 'pet bottle', 'pet', 'polyethylene', 'polypropylene', 'hdpe', 'pvc', 'ldpe', 'polystyrene', 'styrofoam', 'wrapper', 'packet', 'sachet', 'plastic bag', 'plastic cup', 'straw', 'takeout container'] }
];

const NON_WASTE_LABELS = new Set([
  'image',
  'images',
  'input',
  'output',
  'prediction',
  'predictions',
  'object',
  'background',
  'unknown',
  'none',
  'null',
  'waste',
  'trash',
  'garbage'
]);

const LABEL_KEYS = [
  'class',
  'class_name',
  'className',
  'label',
  'name',
  'prediction',
  'predicted_class',
  'top',
  'top_class',
  'detectedItem'
];

const CONFIDENCE_KEYS = [
  'confidence',
  'score',
  'probability',
  'value',
  'percent',
  'prediction_confidence'
];

const MAP_META_KEYS = new Set([
  ...LABEL_KEYS.map((key) => key.toLowerCase()),
  ...CONFIDENCE_KEYS.map((key) => key.toLowerCase()),
  'x',
  'y',
  'width',
  'height',
  'bbox',
  'bounding_box',
  'points',
  'class_id',
  'detection_id',
  'detection_class',
  'data',
  'output',
  'outputs',
  'prediction_groups',
  'predictions',
  'result',
  'results',
  'top_prediction'
]);

function normalizeLabelText(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsKeyword(normalizedText, keyword) {
  const normalizedKeyword = normalizeLabelText(keyword);
  if (!normalizedKeyword) return false;
  return new RegExp(`(^|\\s)${escapeRegExp(normalizedKeyword)}(\\s|$)`).test(normalizedText);
}

function formatLabel(label) {
  return String(label)
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getMaterialCategory(label) {
  const normalized = normalizeLabelText(label);
  if (!normalized) return 'Other';

  const directCategory = MATERIAL_MATCHERS.find(
    (item) => normalized === item.category.toLowerCase()
  );
  if (directCategory) return directCategory.category;

  for (const item of MATERIAL_MATCHERS) {
    if (item.keywords.some((keyword) => normalizeLabelText(keyword) === normalized)) {
      return item.category;
    }
  }

  const match = MATERIAL_MATCHERS.find((item) =>
    item.keywords.some((keyword) => containsKeyword(normalized, keyword))
  );
  return match?.category || 'Other';
}

function getBinCategory(label) {
  const materialCategory = getMaterialCategory(label);
  return WASTE_BIN_MAP[materialCategory] || WASTE_BIN_MAP.Default;
}

function readConfidence(value) {
  if (typeof value === 'number') return value > 1 ? value / 100 : value;
  if (value && typeof value === 'object') {
    for (const key of CONFIDENCE_KEYS) {
      const confidence = readConfidence(value[key]);
      if (confidence > 0) return confidence;
    }
  }
  return 0;
}

function readLabel(prediction) {
  if (!prediction || typeof prediction !== 'object') return null;

  for (const key of LABEL_KEYS) {
    const value = prediction[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (value && typeof value === 'object') {
      const nested = readLabel(value);
      if (nested) return nested;
    }
  }

  return null;
}

function isWastePrediction(prediction) {
  const label = readLabel(prediction);
  if (!label) return false;

  const normalized = normalizeLabelText(label);
  if (NON_WASTE_LABELS.has(normalized)) return false;

  const confidence = readConfidence(prediction);
  const materialCategory = getMaterialCategory(label);

  if (materialCategory !== 'Other') {
    return confidence >= MIN_KNOWN_WASTE_CONFIDENCE;
  }

  return confidence >= MIN_UNKNOWN_WASTE_CONFIDENCE;
}

function looksLikePredictionMap(node) {
  if (!node || Array.isArray(node) || typeof node !== 'object') return false;

  return Object.entries(node).some(([label, value]) => {
    const normalizedLabel = normalizeLabelText(label);
    if (NON_WASTE_LABELS.has(normalizedLabel) || MAP_META_KEYS.has(normalizedLabel)) return false;
    return typeof value === 'number' || readConfidence(value) > 0;
  });
}

function extractPredictionMap(node, predictions) {
  Object.entries(node).forEach(([label, value]) => {
    const normalizedLabel = normalizeLabelText(label);
    if (NON_WASTE_LABELS.has(normalizedLabel) || MAP_META_KEYS.has(normalizedLabel)) return;

    const confidence = readConfidence(value);
    if (confidence > 0) {
      predictions.push({ class: label, confidence });
    }
  });
}

function extractPredictions(node, predictions = [], seen = new Set()) {
  if (!node) return predictions;

  if (Array.isArray(node)) {
    node.forEach((item) => {
      if (isWastePrediction(item)) {
        predictions.push(item);
      } else {
        extractPredictions(item, predictions, seen);
      }
    });
    return predictions;
  }

  if (typeof node !== 'object') return predictions;
  if (seen.has(node)) return predictions;
  seen.add(node);

  if (isWastePrediction(node)) {
    predictions.push(node);
  }

  if (looksLikePredictionMap(node)) {
    extractPredictionMap(node, predictions);
  }

  Object.values(node).forEach((value) => {
    if (value && typeof value === 'object') {
      extractPredictions(value, predictions, seen);
    }
  });

  return predictions;
}

function dedupePredictions(predictions) {
  const bestByLabel = new Map();

  predictions.forEach((prediction) => {
    const label = readLabel(prediction);
    if (!label) return;

    const key = normalizeLabelText(label);
    const confidence = readConfidence(prediction);
    const current = bestByLabel.get(key);

    if (!current || confidence > readConfidence(current)) {
      bestByLabel.set(key, prediction);
    }
  });

  return [...bestByLabel.values()];
}

function normalizePrediction(predictions) {
  const validPredictions = Array.isArray(predictions)
    ? predictions.filter(isWastePrediction)
    : [];

  if (validPredictions.length === 0) return null;

  const topPrediction = [...validPredictions].sort((a, b) => {
    const aScore = readConfidence(a);
    const bScore = readConfidence(b);
    return bScore - aScore;
  })[0];

  const detectedItem = readLabel(topPrediction) || 'Unknown Item';
  const confidence = readConfidence(topPrediction);
  const materialCategory = getMaterialCategory(detectedItem);
  const label = formatLabel(detectedItem);

  return {
    label,
    detectedItem: formatLabel(detectedItem),
    confidence: Number(confidence.toFixed(2)),
    materialCategory,
    binCategory: getBinCategory(detectedItem)
  };
}

function isAdminEmail(email) {
  return ADMIN_EMAILS.includes(String(email || '').toLowerCase());
}

function isAdminBypassRequest(req) {
  return req.get('x-ecocycle-admin') === 'true' &&
    isAdminEmail(req.get('x-ecocycle-admin-email'));
}

function authenticateScanRequest(req, res, next) {
  if (isAdminBypassRequest(req)) {
    req.isAdmin = true;
    req.user = {
      id: `admin-${req.get('x-ecocycle-admin-email').toLowerCase()}`,
      email: req.get('x-ecocycle-admin-email'),
      user_metadata: { name: 'EcoCycle Admin' }
    };
    return next();
  }

  return authenticateToken(req, res, () => {
    req.isAdmin = isAdminEmail(req.user?.email);
    next();
  });
}

function buildPaymentRequiredPayload(scanCredits = 0) {
  return {
    error: 'No scan credits left',
    paymentRequired: true,
    scanCredits,
    freeScanLimit: DEFAULT_FREE_SCAN_CREDITS,
    message: `You have used your free ${DEFAULT_FREE_SCAN_CREDITS} scans. Buy more scan credits to continue identifying waste items.`,
    creditPacks: [
      { quantity: 5, ecoCoins: 50 },
      { quantity: 10, ecoCoins: 100 },
      { quantity: 25, ecoCoins: 250 }
    ],
    paymentUrl: process.env.PAYMENT_BASE_URL
      ? `${process.env.PAYMENT_BASE_URL}/checkout?type=scan&qty=10`
      : null
  };
}

function getDisposalRecommendation(prediction) {
  const category = prediction.materialCategory;
  const bin = prediction.binCategory;

  if (category === 'Compost') {
    return 'Compost this item if it is food or plant matter. Remove stickers, rubber bands, or plastic first.';
  }
  if (category === 'Hazardous') {
    return 'Do not place this in regular bins. Use a hazardous waste drop-off point or local collection event.';
  }
  if (category === 'Electronics') {
    return 'Take this to an e-waste collection point. Remove personal data and batteries where possible.';
  }
  if (category === 'Glass') {
    return `Empty and rinse it, then place it in the ${bin}. Keep ceramics and bulbs separate.`;
  }
  if (category === 'Metal') {
    return `Empty, rinse, and lightly crush if allowed, then place it in the ${bin}.`;
  }
  if (category === 'Paper') {
    return `Keep it clean and dry before placing it in the ${bin}. Greasy paper should go to general waste or compost if accepted locally.`;
  }
  if (category === 'Plastic') {
    return `Empty and rinse it, then place it in the ${bin}. Check local rules for films, wrappers, and mixed plastics.`;
  }

  return `Place this item in the ${bin}. Re-scan in better light if the category looks wrong.`;
}

async function queryRoboflow(imageBase64, imageUrl) {
  const apiKey = process.env.ROBOFLOW_API_KEY;

  if (!apiKey) {
    throw new Error('Roboflow API configuration missing');
  }

  const endpoint = 'https://serverless.roboflow.com/znexs-workspace/workflows/detect-and-classify-5';
  const payload = {
    api_key: apiKey,
    inputs: {
      image: imageUrl
        ? { type: 'url', value: imageUrl }
        : { type: 'base64', value: imageBase64 }
    }
  };

  try {
    const response = await axios.post(endpoint, payload, {
      timeout: 30000,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      }
    });
    return response.data;
  } catch (error) {
    const detail = error.response?.data?.error || error.response?.data?.message || error.message;
    throw new Error(`Roboflow call failed: ${error.response?.status || 'network'} ${detail}`);
  }
}

router.post('/identify', authenticateScanRequest, async (req, res) => {
  const { imageBase64, imageUrl } = req.body;

  if (!imageBase64 && !imageUrl) {
    return res.status(400).json({ error: 'Missing imageBase64 or imageUrl' });
  }

  try {
    const user = await getOrCreateUser(req.user);
    const isAdmin = req.isAdmin || isAdminEmail(user.email);

    if (!isAdmin && user.scanCredits <= 0) {
      return res.status(402).json(buildPaymentRequiredPayload(user.scanCredits));
    }

    const roboflowResult = await queryRoboflow(imageBase64, imageUrl);
    const predictions = dedupePredictions(extractPredictions(roboflowResult));
    console.log('Roboflow prediction count:', predictions.length);
    console.log('Roboflow predictions:', predictions.slice(0, 10).map((item) => ({
      label: readLabel(item),
      confidence: readConfidence(item)
    })));

    const prediction = normalizePrediction(predictions);

    if (!prediction) {
      return res.status(200).json({
        result: {
          label: 'Could not identify waste',
          detectedItem: 'Unknown Item',
          materialCategory: 'Other',
          binCategory: 'General Waste',
          confidence: 0,
          sellable: false,
          xpReward: 0,
          co2Saved: 0,
          recommendation: 'Try scanning the item again with better lighting.',
          priceEstimate: '--'
        }
      });
    }

    const xpReward = Math.max(5, Math.min(30, Math.round(prediction.confidence * 25)));
    const co2Saved = Number((xpReward * 0.35).toFixed(2));

    res.json({
      result: {
        label: prediction.label,
        detectedItem: prediction.detectedItem,
        materialCategory: prediction.materialCategory,
        binCategory: prediction.binCategory,
        confidence: prediction.confidence,
        sellable: ['Plastic', 'Glass', 'Paper', 'Metal', 'Electronics'].includes(prediction.materialCategory) &&
          prediction.confidence > 0.45,
        xpReward,
        co2Saved,
        recommendation: getDisposalRecommendation(prediction),
        priceEstimate: `(estimate ${Math.max(1, Math.round(prediction.confidence * 10))} EcoCoins)`
      }
    });
  } catch (error) {
    console.error('Roboflow identify error:', error);
    res.status(500).json({ error: 'Failed to identify image', detail: error.message });
  }
});

router.post('/', authenticateScanRequest, async (req, res) => {
  const { type, binCategory, xpReward, co2Saved } = req.body;

  if (!type || !binCategory) {
    return res.status(400).json({ error: 'type and binCategory are required' });
  }

  try {
    const user = await getOrCreateUser(req.user);
    const isAdmin = req.isAdmin || isAdminEmail(user.email);

    if (!isAdmin && user.scanCredits <= 0) {
      return res.status(402).json(buildPaymentRequiredPayload(user.scanCredits));
    }

    const scan = await prisma.scan.create({
      data: {
        type,
        binCategory,
        xpReward: xpReward || 10,
        co2Saved: co2Saved || 0.5,
        userId: user.id
      }
    });

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        xpPoints: { increment: scan.xpReward },
        co2Saved: { increment: scan.co2Saved },
        ...(isAdmin ? {} : { scanCredits: { decrement: 1 } })
      }
    });

    res.json({
      message: isAdmin
        ? 'Admin scan logged successfully. Credits were not decremented.'
        : 'Scan logged successfully',
      adminUnlimited: isAdmin,
      scan,
      updatedUser
    });
  } catch (error) {
    console.error('Error logging scan:', error);
    res.status(500).json({ error: 'Failed to log scan' });
  }
});

module.exports = router;
