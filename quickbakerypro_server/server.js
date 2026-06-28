require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const multer  = require('multer');

const authRoutes           = require('./routes/auth');
const usersRoutes          = require('./routes/users');
const categoriesRoutes     = require('./routes/categories');
const productsRoutes       = require('./routes/products');
const inventoryRoutes      = require('./routes/inventory');
const suppliersRoutes      = require('./routes/suppliers');
const purchaseOrdersRoutes = require('./routes/purchase_orders');
const customersRoutes      = require('./routes/customers');
const salesRoutes          = require('./routes/sales');
const promotionsRoutes     = require('./routes/promotions');
const backupRoutes         = require('./routes/backup');
const seedRoutes           = require('./routes/seed');
const staffRoutes          = require('./routes/staff');
const invoicesRoutes       = require('./routes/invoices');
const billsRoutes          = require('./routes/bills');
const expensesRoutes       = require('./routes/expenses');
const accountsRoutes       = require('./routes/accounts');

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Product image upload
const productImageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads', 'products')),
  filename:    (req, file, cb) => cb(null, `product_${Date.now()}${path.extname(file.originalname).toLowerCase()}`),
});
const uploadProductImage = multer({
  storage: productImageStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['.jpg','.jpeg','.png','.webp'].includes(
      path.extname(file.originalname).toLowerCase());
    cb(null, ok);
  },
});

app.post('/api/upload/product-image', uploadProductImage.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file provided.' });
  res.json({ image_url: `/uploads/products/${req.file.filename}` });
});

app.use((req, res, next) => { console.log(`${req.method} ${req.url}`); next(); });

app.use('/api/auth',            authRoutes);
app.use('/api/users',           usersRoutes);
app.use('/api/categories',      categoriesRoutes);
app.use('/api/products',        productsRoutes);
app.use('/api/inventory',       inventoryRoutes);
app.use('/api/suppliers',       suppliersRoutes);
app.use('/api/purchase-orders', purchaseOrdersRoutes);
app.use('/api/customers',       customersRoutes);
app.use('/api/sales',           salesRoutes);
app.use('/api/promotions',      promotionsRoutes);
app.use('/api/backup',          backupRoutes);
app.use('/api/seed',            seedRoutes);
app.use('/api/staff',           staffRoutes);
app.use('/api/invoices',        invoicesRoutes);
app.use('/api/bills',           billsRoutes);
app.use('/api/expenses',        expensesRoutes);
app.use('/api/accounts',        accountsRoutes);

app.get('/', (req, res) => res.json({ status: 'QuickBakeryPro API running' }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () =>
  console.log(`QuickBakeryPro server listening on http://localhost:${PORT}`));