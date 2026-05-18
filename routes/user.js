const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth');
const prisma = require('../prisma');
const { getOrCreateUser } = require('../utils/users');

// Create user profile (after Supabase signup)
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

// Get User Profile (Protected Route)
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    let user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: {
        scans: true,
        listings: true
      }
    });

    if (!user) {
      user = await getOrCreateUser(req.user);
      user = await prisma.user.findUnique({
        where: { id: user.id },
        include: {
          scans: true,
          listings: true
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

// Purchase credits placeholder endpoint
router.post('/purchase', authenticateToken, async (req, res) => {
  const { type, quantity } = req.body;
  const qty = Number(quantity) || 5;

  if (!['scan', 'market'].includes(type)) {
    return res.status(400).json({ error: 'Invalid purchase type. Use scan or market.' });
  }

  const paymentUrl = process.env.PAYMENT_BASE_URL
    ? `${process.env.PAYMENT_BASE_URL}/checkout?type=${type}&qty=${qty}`
    : `https://example.com/pay?type=${type}&qty=${qty}`;

  res.json({
    message: 'Payment required to purchase credits.',
    paymentUrl,
    amountDue: type === 'scan' ? qty * 0.99 : qty * 1.49,
    credits: qty
  });
});

module.exports = router;
