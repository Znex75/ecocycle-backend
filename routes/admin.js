const express = require('express');
const router = express.Router();
const prisma = require('../prisma');

// Get Admin Statistics
router.get('/stats', async (req, res) => {
  try {
    const userCount = await prisma.user.count();
    const scanCount = await prisma.scan.count();
    const listingCount = await prisma.listing.count();

    const users = await prisma.user.findMany();
    const totalXP = users.reduce((acc, u) => acc + (u.xpPoints || 0), 0);
    const totalCO2 = users.reduce((acc, u) => acc + (u.co2Saved || 0), 0);

    res.json({
      success: true,
      stats: {
        users: userCount,
        scans: scanCount,
        listings: listingCount,
        totalXP,
        totalCO2: Number(totalCO2.toFixed(2))
      }
    });
  } catch (error) {
    console.error('Error fetching admin stats:', error);
    res.status(500).json({ error: 'Failed to fetch admin stats', detail: error.message });
  }
});

// Get All Users
router.get('/users', async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      include: {
        scans: true,
        listings: true
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, users });
  } catch (error) {
    console.error('Error fetching admin users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get All Scans
router.get('/scans', async (req, res) => {
  try {
    const scans = await prisma.scan.findMany({
      include: {
        user: { select: { name: true, email: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, scans });
  } catch (error) {
    console.error('Error fetching admin scans:', error);
    res.status(500).json({ error: 'Failed to fetch scans' });
  }
});

// Get All Listings
router.get('/market', async (req, res) => {
  try {
    const listings = await prisma.listing.findMany({
      include: {
        seller: { select: { name: true, email: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, listings });
  } catch (error) {
    console.error('Error fetching admin market listings:', error);
    res.status(500).json({ error: 'Failed to fetch listings' });
  }
});

// Update User Credits / Admin action
router.post('/user/update-credits', async (req, res) => {
  const { userId, scanCredits, marketCredits } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  try {
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        scanCredits: scanCredits !== undefined ? Number(scanCredits) : undefined,
        marketCredits: marketCredits !== undefined ? Number(marketCredits) : undefined
      }
    });

    res.json({ success: true, message: 'User credits updated successfully', user: updatedUser });
  } catch (error) {
    console.error('Error updating user credits:', error);
    res.status(500).json({ error: 'Failed to update user credits' });
  }
});

module.exports = router;
