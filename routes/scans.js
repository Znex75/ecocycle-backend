const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth');
const prisma = require('../prisma');
const axios = require('axios');
const { getOrCreateUser } = require('../utils/users');

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
  { category: 'Plastic', keywords: ['plastic', 'bottle', 'pet', 'polyethylene', 'polypropylene'] },
  { category: 'Glass', keywords: ['glass', 'jar'] },
  { category: 'Paper', keywords: ['paper', 'cardboard', 'carton', 'book', 'newspaper'] },
  { category: 'Metal', keywords: ['metal', 'aluminium', 'aluminum', 'steel', 'tin', 'can', 'copper', 'wire'] },
  { category: 'Electronics', keywords: ['electronic', 'e-waste', 'battery', 'phone', 'keyboard', 'cable'] },
  { category: 'Compost', keywords: ['compost', 'organic', 'food', 'leaf', 'leaves'] },
  { category: 'Hazardous', keywords: ['hazard', 'chemical', 'paint', 'medical'] }
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
  'null'
]);

function formatLabel(label) {
  return String(label)
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getMaterialCategory(label) {
  const normalized = String(label).toLowerCase();
  const match = MATERIAL_MATCHERS.find((item) =>
    item.keywords.some((keyword) => normalized.includes(keyword))
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
    return readConfidence(value.confidence ?? value.score ?? value.probability ?? value.value);
  }
  return 0;
}

function readLabel(prediction) {
  if (!prediction || typeof prediction !== 'object') return null;
  return prediction.class || prediction.label || prediction.predicted_class || prediction.top_class || prediction.name || null;
}

function isWastePrediction(prediction) {
  const label = readLabel(prediction);
  if (!label) return false;

  const normalized = String(label).toLowerCase().trim();
  if (NON_WASTE_LABELS.has(normalized)) return false;

  return readConfidence(prediction.confidence ?? prediction.score ?? prediction.probability ?? prediction.value) > 0;
}

function extractPredictions(node, predictions = []) {
  if (!node) return predictions;

  if (Array.isArray(node)) {
    node.forEach((item) => extractPredictions(item, predictions));
    return predictions;
  }

  if (typeof node !== 'object') return predictions;

  if (isWastePrediction(node)) {
    predictions.push(node);
  }

  if (node.predictions && typeof node.predictions === 'object' && !Array.isArray(node.predictions)) {
    Object.entries(node.predictions).forEach(([label, value]) => {
      predictions.push({
        class: label,
        confidence: readConfidence(value)
      });
    });
  }

  if (node.top_class) {
    predictions.push({
      class: node.top_class,
      confidence: readConfidence(node.top_class_confidence ?? node.confidence ?? node.score ?? 0)
    });
  }

  Object.entries(node).forEach(([key, value]) => {
    if (key === 'inputs') return;
    extractPredictions(value, predictions);
  });

  return predictions;
}

function normalizePrediction(predictions) {
  const validPredictions = Array.isArray(predictions)
    ? predictions.filter(isWastePrediction)
    : [];

  if (validPredictions.length === 0) return null;

  const topPrediction = [...validPredictions].sort((a, b) => {
    const aScore = readConfidence(a.confidence ?? a.score ?? a.probability ?? a.value);
    const bScore = readConfidence(b.confidence ?? b.score ?? b.probability ?? b.value);
    return bScore - aScore;
  })[0];

  const detectedItem = readLabel(topPrediction) || 'Unknown Item';
  const confidence = readConfidence(topPrediction.confidence ?? topPrediction.score ?? topPrediction.probability ?? topPrediction.value);
  const materialCategory = getMaterialCategory(detectedItem);
  const label = materialCategory === 'Other' ? formatLabel(detectedItem) : materialCategory;

  return {
    label,
    detectedItem: formatLabel(detectedItem),
    confidence: Number(confidence.toFixed(2)),
    materialCategory,
    binCategory: getBinCategory(detectedItem)
  };
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

router.post('/identify', authenticateToken, async (req, res) => {
  const { imageBase64, imageUrl } = req.body;

  if (!imageBase64 && !imageUrl) {
    return res.status(400).json({ error: 'Missing imageBase64 or imageUrl' });
  }

  try {
    const user = await getOrCreateUser(req.user);

    if (user.scanCredits <= 0) {
      return res.status(402).json({
        error: 'No scan credits left',
        paymentRequired: true,
        message: 'Buy more scan credits to continue identifying waste items.',
        paymentUrl: process.env.PAYMENT_BASE_URL
          ? `${process.env.PAYMENT_BASE_URL}/checkout?type=scan&qty=5`
          : 'https://example.com/pay?type=scan&qty=5'
      });
    }

    const roboflowResult = await queryRoboflow(imageBase64, imageUrl);
    const predictions = extractPredictions(roboflowResult);
    console.log('Roboflow predictions:', predictions.map((item) => ({
      label: readLabel(item),
      confidence: readConfidence(item.confidence ?? item.score ?? item.probability ?? item.value)
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
        sellable: prediction.confidence > 0.5,
        xpReward,
        co2Saved,
        recommendation: `Place this item in the ${prediction.binCategory}.`,
        priceEstimate: `(estimate ${Math.max(1, Math.round(prediction.confidence * 10))} EcoCoins)`
      }
    });
  } catch (error) {
    console.error('Roboflow identify error:', error);
    res.status(500).json({ error: 'Failed to identify image', detail: error.message });
  }
});

router.post('/', authenticateToken, async (req, res) => {
  const { type, binCategory, xpReward, co2Saved } = req.body;

  if (!type || !binCategory) {
    return res.status(400).json({ error: 'type and binCategory are required' });
  }

  try {
    const user = await getOrCreateUser(req.user);

    if (user.scanCredits <= 0) {
      return res.status(402).json({
        error: 'No scan credits left',
        paymentRequired: true,
        paymentUrl: process.env.PAYMENT_BASE_URL
          ? `${process.env.PAYMENT_BASE_URL}/checkout?type=scan&qty=5`
          : 'https://example.com/pay?type=scan&qty=5'
      });
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
        scanCredits: { decrement: 1 }
      }
    });

    res.json({ message: 'Scan logged successfully', scan, updatedUser });
  } catch (error) {
    console.error('Error logging scan:', error);
    res.status(500).json({ error: 'Failed to log scan' });
  }
});

module.exports = router;
