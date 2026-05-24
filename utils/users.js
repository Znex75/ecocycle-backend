const prisma = require('../prisma');

const DEFAULT_FREE_SCAN_CREDITS = Number(process.env.DEFAULT_FREE_SCAN_CREDITS || 25);

async function getOrCreateUser(authUser, profile = {}) {
  const email = profile.email || authUser.email || `${authUser.id}@ecocycle.local`;
  const name =
    profile.name ||
    authUser.user_metadata?.name ||
    authUser.email?.split('@')[0] ||
    'Eco Warrior';

  let user = await prisma.user.findUnique({ where: { id: authUser.id } });
  if (user) return user;

  if (email) {
    user = await prisma.user.findUnique({ where: { email } });
    if (user) return user;
  }

  try {
    return await prisma.user.create({
      data: {
        id: authUser.id,
        name,
        email,
        scanCredits: DEFAULT_FREE_SCAN_CREDITS
      }
    });
  } catch (error) {
    if (error.code === 'P2002' && email) {
      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (existingUser) return existingUser;
    }

    throw error;
  }
}

module.exports = {
  getOrCreateUser
};
