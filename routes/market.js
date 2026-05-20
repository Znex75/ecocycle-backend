const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth');
const prisma = require('../prisma');
const { getOrCreateUser } = require('../utils/users');

// ================= GET ALL ACTIVE LISTINGS =================
router.get('/listings', authenticateToken, async (req, res) => {
  try {
    const listings = await prisma.listing.findMany({
      where: { status: 'active' },
      orderBy: { createdAt: 'desc' },
      include: {
        seller: {
          select: {
            id: true,
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

// ================= GET MY LISTINGS (seller's own) =================
router.get('/my-listings', authenticateToken, async (req, res) => {
  try {
    const user = await getOrCreateUser(req.user);
    const listings = await prisma.listing.findMany({
      where: { sellerId: user.id },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ listings });
  } catch (error) {
    console.error('Error fetching my listings:', error);
    res.status(500).json({ error: 'Failed to fetch your listings' });
  }
});

// ================= GET MY PURCHASES =================
router.get('/my-purchases', authenticateToken, async (req, res) => {
  try {
    const user = await getOrCreateUser(req.user);
    const purchases = await prisma.listing.findMany({
      where: { buyerId: user.id },
      orderBy: { createdAt: 'desc' },
      include: {
        seller: {
          select: { name: true, email: true }
        }
      }
    });
    res.json({ purchases });
  } catch (error) {
    console.error('Error fetching purchases:', error);
    res.status(500).json({ error: 'Failed to fetch purchases' });
  }
});

// ================= LIST (SELL) AN ITEM =================
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
        message: 'Buy more market listing credits or top up EcoCoins to list items.'
      });
    }

    const listing = await prisma.listing.create({
      data: {
        title,
        description,
        price: Number(price),
        category: category || 'Other',
        image: image || '',
        status: 'active',
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

// ================= BUY AN ITEM =================
router.post('/buy/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const buyer = await getOrCreateUser(req.user);

    const listing = await prisma.listing.findUnique({
      where: { id },
      include: { seller: true }
    });

    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    if (listing.status !== 'active') {
      return res.status(400).json({ error: 'This item has already been sold' });
    }

    if (listing.sellerId === buyer.id) {
      return res.status(400).json({ error: 'You cannot buy your own listing' });
    }

    if (buyer.ecoCoins < listing.price) {
      return res.status(402).json({
        error: 'Not enough EcoCoins',
        required: listing.price,
        balance: buyer.ecoCoins,
        message: `You need ${listing.price - buyer.ecoCoins} more EcoCoins. Top up from your profile.`
      });
    }

    // Perform the transaction atomically
    const result = await prisma.$transaction(async (tx) => {
      // Deduct from buyer
      const updatedBuyer = await tx.user.update({
        where: { id: buyer.id },
        data: { ecoCoins: { decrement: listing.price } }
      });

      // Credit the seller
      await tx.user.update({
        where: { id: listing.sellerId },
        data: { ecoCoins: { increment: listing.price } }
      });

      // Mark listing as sold
      const updatedListing = await tx.listing.update({
        where: { id: listing.id },
        data: {
          status: 'sold',
          buyerId: buyer.id
        }
      });

      // Record a transaction for the buyer (debit)
      await tx.transaction.create({
        data: {
          type: 'purchase',
          amount: listing.price,
          description: `Bought "${listing.title}" from ${listing.seller.name}`,
          fromUserId: buyer.id,
          toUserId: listing.sellerId,
          listingId: listing.id
        }
      });

      // Record a transaction for the seller (credit)
      await tx.transaction.create({
        data: {
          type: 'sale',
          amount: listing.price,
          description: `Sold "${listing.title}" to ${updatedBuyer.name}`,
          fromUserId: buyer.id,
          toUserId: listing.sellerId,
          listingId: listing.id
        }
      });

      return { updatedBuyer, updatedListing };
    });

    res.json({
      message: 'Purchase successful!',
      listing: result.updatedListing,
      newBalance: result.updatedBuyer.ecoCoins
    });
  } catch (error) {
    console.error('Error buying listing:', error);
    res.status(500).json({ error: 'Failed to complete purchase' });
  }
});

// ================= DELETE A LISTING =================
router.delete('/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const user = await getOrCreateUser(req.user);
    const listing = await prisma.listing.findUnique({
      where: { id }
    });

    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    if (listing.sellerId !== user.id) {
      return res.status(403).json({ error: 'You can only delete your own listings' });
    }

    if (listing.status === 'sold') {
      return res.status(400).json({ error: 'Cannot delete a sold listing' });
    }

    await prisma.listing.delete({
      where: { id }
    });

    // Refund market credit
    await prisma.user.update({
      where: { id: user.id },
      data: { marketCredits: { increment: 1 } }
    });

    res.json({ message: 'Listing deleted successfully' });
  } catch (error) {
    console.error('Error deleting listing:', error);
    res.status(500).json({ error: 'Failed to delete listing' });
  }
});

module.exports = router;
