const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth');
const prisma = require('../prisma');
const { getOrCreateUser } = require('../utils/users');

// ================= CREATE/VERIFY PROFILE =================
router.post('/profile', authenticateToken, async (req, res) => {
  const { name, email } = req.body;

  try {
    const user = await getOrCreateUser(req.user, { name, email });
    res.json({ message: 'Profile created/verified successfully', user });
  } catch (error) {
    console.error('Error creating profile:', error);
    res.status(500).json({ error: 'Failed to create profile' });
  }
});

// ================= GET PROFILE =================
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    let user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: {
        scans: true,
        listings: { where: { status: 'active' } }
      }
    });

    if (!user) {
      user = await getOrCreateUser(req.user);
      user = await prisma.user.findUnique({
        where: { id: user.id },
        include: {
          scans: true,
          listings: { where: { status: 'active' } }
        }
      });
    }

    res.json({
      message: 'Profile retrieved successfully',
      user
    });
  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ================= WALLET: GET BALANCE + TRANSACTIONS =================
router.get('/wallet', authenticateToken, async (req, res) => {
  try {
    const user = await getOrCreateUser(req.user);

    const transactions = await prisma.transaction.findMany({
      where: {
        OR: [
          { fromUserId: user.id },
          { toUserId: user.id }
        ]
      },
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    // Format transactions for frontend
    const formatted = transactions.map(txn => ({
      id: txn.id,
      type: txn.toUserId === user.id ? 'credit' : 'debit',
      amount: txn.amount,
      description: txn.description,
      date: txn.createdAt
    }));

    res.json({
      ecoCoins: user.ecoCoins,
      scanCredits: user.scanCredits,
      marketCredits: user.marketCredits,
      transactions: formatted
    });
  } catch (error) {
    console.error('Error fetching wallet:', error);
    res.status(500).json({ error: 'Failed to fetch wallet' });
  }
});

// ================= TOP UP ECOCOINS (Demo: free top-up) =================
router.post('/topup', authenticateToken, async (req, res) => {
  const { amount } = req.body;
  const topupAmount = Math.min(Number(amount) || 50, 500); // max 500 per top-up

  try {
    const user = await getOrCreateUser(req.user);

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { ecoCoins: { increment: topupAmount } }
    });

    // Record transaction
    await prisma.transaction.create({
      data: {
        type: 'topup',
        amount: topupAmount,
        description: `Topped up ${topupAmount} EcoCoins`,
        toUserId: user.id
      }
    });

    res.json({
      message: `Successfully added ${topupAmount} EcoCoins!`,
      newBalance: updatedUser.ecoCoins
    });
  } catch (error) {
    console.error('Error topping up:', error);
    res.status(500).json({ error: 'Failed to top up EcoCoins' });
  }
});

// ================= PURCHASE CREDITS =================
router.post('/purchase', authenticateToken, async (req, res) => {
  const { type, quantity } = req.body;
  const qty = Number(quantity) || 5;

  if (!['scan', 'market'].includes(type)) {
    return res.status(400).json({ error: 'Invalid purchase type. Use scan or market.' });
  }

  try {
    const user = await getOrCreateUser(req.user);

    // Cost in EcoCoins: scan credits cost 10 each, market credits cost 15 each
    const costPerCredit = type === 'scan' ? 10 : 15;
    const totalCost = costPerCredit * qty;

    if (user.ecoCoins < totalCost) {
      return res.status(402).json({
        error: 'Not enough EcoCoins',
        required: totalCost,
        balance: user.ecoCoins,
        message: `You need ${totalCost} EcoCoins (${costPerCredit} per credit × ${qty}). Top up first!`
      });
    }

    const updateData = {
      ecoCoins: { decrement: totalCost }
    };

    if (type === 'scan') {
      updateData.scanCredits = { increment: qty };
    } else {
      updateData.marketCredits = { increment: qty };
    }

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: updateData
    });

    // Record transaction
    await prisma.transaction.create({
      data: {
        type: 'credit_purchase',
        amount: totalCost,
        description: `Bought ${qty} ${type} credits for ${totalCost} EcoCoins`,
        fromUserId: user.id
      }
    });

    res.json({
      message: `Successfully purchased ${qty} ${type} credits!`,
      creditsAdded: qty,
      ecoCoinsSpent: totalCost,
      newBalance: updatedUser.ecoCoins,
      scanCredits: updatedUser.scanCredits,
      marketCredits: updatedUser.marketCredits
    });
  } catch (error) {
    console.error('Error purchasing credits:', error);
    res.status(500).json({ error: 'Failed to purchase credits' });
  }
});

module.exports = router;
