const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth');
const prisma = require('../prisma');
const { getOrCreateUser } = require('../utils/users');

router.get('/listings', authenticateToken, async (req, res) => {
  try {
    const listings = await prisma.listing.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        seller: {
          select: {
            name: true,
            email: true
          }
        }
      }
    });

    res.json({ listings });
  } catch (error) {
    console.error('Error fetching listings:', error);
    res.status(500).json({ error: 'Failed to fetch listings' });
  }
});

router.post('/list', authenticateToken, async (req, res) => {
  const { title, description, price, category, image } = req.body;

  if (!title || !description || !price) {
    return res.status(400).json({ error: 'title, description, and price are required' });
  }

  try {
    const user = await getOrCreateUser(req.user);

    if (user.marketCredits <= 0) {
      return res.status(402).json({
        error: 'No market listings left',
        paymentRequired: true,
        message: 'Buy more market listing credits to sell waste in the marketplace.',
        paymentUrl: process.env.PAYMENT_BASE_URL
          ? `${process.env.PAYMENT_BASE_URL}/checkout?type=market&qty=2`
          : 'https://example.com/pay?type=market&qty=2'
      });
    }

    const listing = await prisma.listing.create({
      data: {
        title,
        description,
        price: Number(price),
        category: category || 'Other',
        image: image || '',
        sellerId: user.id
      }
    });

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        marketCredits: { decrement: 1 }
      }
    });

    res.json({ message: 'Item listed successfully', listing, updatedUser });
  } catch (error) {
    console.error('Error creating listing:', error);
    res.status(500).json({ error: 'Failed to list item' });
  }
});

module.exports = router;
