require('dotenv').config();
const ensureDatabaseSchema = require('./utils/ensureDatabaseSchema');
const express = require('express');
const cors = require('cors');

try {
  ensureDatabaseSchema();
} catch (error) {
  console.error('Database schema check failed:', error);
  process.exit(1);
}

const userRoutes = require('./routes/user');

const app = express();

// Middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Private-Network', 'true');
  next();
});
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Routes
app.use('/api/user', userRoutes);
const scanRoutes = require('./routes/scans');
app.use('/api/scans', scanRoutes);
const marketRoutes = require('./routes/market');
app.use('/api/market', marketRoutes);
const adminRoutes = require('./routes/admin');
app.use('/api/admin', adminRoutes);

// Basic health check route
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend is running!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
