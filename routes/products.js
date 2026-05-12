const express = require('express');
const router = express.Router();
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { body, validationResult } = require('express-validator');
const Product = require('../models/Product');
const PriceHistory = require('../models/PriceHistory');
const User = require('../models/User');
const { protect, restrictTo } = require('../middleware/auth');

// ============================================================
// Cloudinary Configuration
// ============================================================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'krishisetu/products',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ width: 800, height: 800, crop: 'limit', quality: 'auto' }]
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// ============================================================
// @route   POST /api/products
// @desc    Farmer creates a new product listing
// @access  Farmer only
// ============================================================
router.post(
  '/',
  protect,
  restrictTo('farmer'),
  upload.array('images', 4),
  [
    body('name').trim().notEmpty().withMessage('Product name is required'),
    body('category').notEmpty().withMessage('Category is required'),
    body('pricePerUnit').isNumeric().withMessage('Price must be a number'),
    body('quantityAvailable').isNumeric().withMessage('Quantity must be a number'),
    body('unit').notEmpty().withMessage('Unit is required')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      // Check farmer is approved
      const farmer = await User.findById(req.user._id);
      if (!farmer.isApproved) {
        return res.status(403).json({
          message: 'Your account is pending admin approval. You cannot list products yet.'
        });
      }

      const {
        name,
        nameHindi,
        category,
        description,
        descriptionHindi,
        pricePerUnit,
        unit,
        quantityAvailable,
        minimumOrderQuantity,
        isOrganic,
        harvestDate,
        tags
      } = req.body;

      // Get uploaded image URLs from Cloudinary
      const images = req.files ? req.files.map(f => f.path) : [];

      // Build product with farmer's location + delivery radius
      const product = await Product.create({
        farmer: req.user._id,
        name,
        nameHindi: nameHindi || '',
        category,
        description: description || '',
        descriptionHindi: descriptionHindi || '',
        pricePerUnit: parseFloat(pricePerUnit),
        unit,
        quantityAvailable: parseFloat(quantityAvailable),
        minimumOrderQuantity: parseFloat(minimumOrderQuantity) || 1,
        images,
        isOrganic: isOrganic === 'true' || isOrganic === true,
        harvestDate: harvestDate || null,
        tags: tags ? (Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim())) : [],
        // Copy farmer's location and radius to product for geo queries
        location: farmer.location,
        deliveryRadiusKm: farmer.deliveryRadiusKm,
        isAvailable: true
      });

      // Record initial price in history for AI model
      await PriceHistory.recordPrice({
        farmer: req.user._id,
        product: product._id,
        cropName: name.toLowerCase(),
        category,
        pricePerUnit: parseFloat(pricePerUnit),
        unit,
        source: 'manual'
      });

      res.status(201).json({
        message: 'Product listed successfully!',
        product
      });
    } catch (error) {
      console.error('Create product error:', error);
      res.status(500).json({ message: 'Server error', error: error.message });
    }
  }
);

// ============================================================
// @route   GET /api/products
// @desc    Get products filtered by consumer's location + radius
// @access  Public
// ============================================================
router.get('/', async (req, res) => {
  try {
    const {
      longitude,
      latitude,
      category,
      search,
      minPrice,
      maxPrice,
      isOrganic,
      sortBy,
      page = 1,
      limit = 12
    } = req.query;

    let query = { isAvailable: true, quantityAvailable: { $gt: 0 } };

    // Geospatial filter — show only products that deliver to consumer's location
    if (longitude && latitude) {
      const consumerCoords = [parseFloat(longitude), parseFloat(latitude)];

      // We use aggregation for radius check:
      // Each product has its own deliveryRadiusKm
      // Consumer sees product only if they are within that radius
      const products = await Product.aggregate([
        {
          $geoNear: {
            near: { type: 'Point', coordinates: consumerCoords },
            distanceField: 'distanceFromConsumer',
            distanceMultiplier: 0.001, // convert meters to km
            spherical: true,
            query
          }
        },
        // Only include if consumer is within farmer's delivery radius
        {
          $match: {
            $expr: {
              $lte: ['$distanceFromConsumer', '$deliveryRadiusKm']
            }
          }
        },
        // Apply additional filters
        ...(category ? [{ $match: { category } }] : []),
        ...(isOrganic === 'true' ? [{ $match: { isOrganic: true } }] : []),
        ...(minPrice ? [{ $match: { pricePerUnit: { $gte: parseFloat(minPrice) } } }] : []),
        ...(maxPrice ? [{ $match: { pricePerUnit: { $lte: parseFloat(maxPrice) } } }] : []),
        ...(search
          ? [{ $match: { $or: [
              { name: { $regex: search, $options: 'i' } },
              { tags: { $elemMatch: { $regex: search, $options: 'i' } } }
            ]}}]
          : []),
        // Lookup farmer details
        {
          $lookup: {
            from: 'users',
            localField: 'farmer',
            foreignField: '_id',
            as: 'farmerDetails'
          }
        },
        { $unwind: '$farmerDetails' },
        {
          $project: {
            name: 1,
            nameHindi: 1,
            category: 1,
            description: 1,
            descriptionHindi: 1,
            pricePerUnit: 1,
            unit: 1,
            quantityAvailable: 1,
            minimumOrderQuantity: 1,
            images: 1,
            isOrganic: 1,
            harvestDate: 1,
            tags: 1,
            rating: 1,
            distanceFromConsumer: { $round: ['$distanceFromConsumer', 1] },
            'farmerDetails.name': 1,
            'farmerDetails.farmName': 1,
            'farmerDetails.rating': 1,
            'farmerDetails._id': 1,
            createdAt: 1
          }
        },
        // Sorting
        {
          $sort:
            sortBy === 'price_asc' ? { pricePerUnit: 1 }
            : sortBy === 'price_desc' ? { pricePerUnit: -1 }
            : sortBy === 'rating' ? { 'rating.average': -1 }
            : sortBy === 'distance' ? { distanceFromConsumer: 1 }
            : { createdAt: -1 }
        },
        // Pagination
        { $skip: (parseInt(page) - 1) * parseInt(limit) },
        { $limit: parseInt(limit) }
      ]);

      return res.json({
        products,
        page: parseInt(page),
        count: products.length
      });
    }

    // No location provided — return all available products (no geo filter)
    const products = await Product.find(query)
      .populate('farmer', 'name farmName rating')
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit));

    res.json({ products, page: parseInt(page), count: products.length });
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ============================================================
// @route   GET /api/products/:id
// @desc    Get single product details
// @access  Public
// ============================================================
router.get('/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).populate(
      'farmer',
      'name farmName rating location deliveryRadiusKm phone'
    );

    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    res.json({ product });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// @route   PUT /api/products/:id
// @desc    Farmer updates product (price, quantity, etc.)
// @access  Farmer only
// ============================================================
router.put(
  '/:id',
  protect,
  restrictTo('farmer'),
  upload.array('images', 4),
  async (req, res) => {
    try {
      const product = await Product.findById(req.params.id);

      if (!product) {
        return res.status(404).json({ message: 'Product not found' });
      }

      // Only the farmer who owns it can update
      if (product.farmer.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: 'Not authorized' });
      }

      const {
        name,
        nameHindi,
        description,
        descriptionHindi,
        pricePerUnit,
        quantityAvailable,
        minimumOrderQuantity,
        isOrganic,
        harvestDate,
        tags,
        isAvailable
      } = req.body;

      // Track price change for AI model
      const priceChanged =
        pricePerUnit && parseFloat(pricePerUnit) !== product.pricePerUnit;

      // Update fields
      if (name) product.name = name;
      if (nameHindi) product.nameHindi = nameHindi;
      if (description) product.description = description;
      if (descriptionHindi) product.descriptionHindi = descriptionHindi;
      if (pricePerUnit) product.pricePerUnit = parseFloat(pricePerUnit);
      if (quantityAvailable !== undefined) {
        product.quantityAvailable = parseFloat(quantityAvailable);
        // Auto set availability based on stock
        product.isAvailable = parseFloat(quantityAvailable) > 0;
      }
      if (minimumOrderQuantity) product.minimumOrderQuantity = parseFloat(minimumOrderQuantity);
      if (isOrganic !== undefined) product.isOrganic = isOrganic === 'true' || isOrganic === true;
      if (harvestDate) product.harvestDate = harvestDate;
      if (isAvailable !== undefined) product.isAvailable = isAvailable === 'true' || isAvailable === true;
      if (tags) product.tags = Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim());

      // Add new images if uploaded
      if (req.files && req.files.length > 0) {
        const newImages = req.files.map(f => f.path);
        product.images = [...product.images, ...newImages].slice(0, 4);
      }

      await product.save();

      // Record price change in history for AI
      if (priceChanged) {
        await PriceHistory.recordPrice({
          farmer: req.user._id,
          product: product._id,
          cropName: product.name.toLowerCase(),
          category: product.category,
          pricePerUnit: parseFloat(pricePerUnit),
          unit: product.unit,
          source: 'manual'
        });
      }

      res.json({ message: 'Product updated successfully', product });
    } catch (error) {
      console.error('Update product error:', error);
      res.status(500).json({ message: 'Server error', error: error.message });
    }
  }
);

// ============================================================
// @route   DELETE /api/products/:id
// @desc    Farmer deletes a product
// @access  Farmer only
// ============================================================
router.delete('/:id', protect, restrictTo('farmer'), async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    if (product.farmer.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    // Delete images from Cloudinary
    for (const imageUrl of product.images) {
      try {
        const publicId = imageUrl.split('/').slice(-2).join('/').split('.')[0];
        await cloudinary.uploader.destroy(publicId);
      } catch (err) {
        console.error('Cloudinary delete error:', err);
      }
    }

    await product.deleteOne();
    res.json({ message: 'Product deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// @route   GET /api/products/farmer/my-products
// @desc    Get all products listed by logged in farmer
// @access  Farmer only
// ============================================================
router.get(
  '/farmer/my-products',
  protect,
  restrictTo('farmer'),
  async (req, res) => {
    try {
      const products = await Product.find({ farmer: req.user._id }).sort({
        createdAt: -1
      });

      // Add stock status to each product
      const productsWithStatus = products.map(p => ({
        ...p.toObject(),
        stockStatus:
          p.quantityAvailable === 0
            ? 'out_of_stock'
            : p.quantityAvailable < 10
            ? 'low_stock'
            : 'in_stock'
      }));

      res.json({ products: productsWithStatus, count: products.length });
    } catch (error) {
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// ============================================================
// @route   DELETE /api/products/:id/image
// @desc    Remove a specific image from product
// @access  Farmer only
// ============================================================
router.delete('/:id/image', protect, restrictTo('farmer'), async (req, res) => {
  try {
    const { imageUrl } = req.body;
    const product = await Product.findById(req.params.id);

    if (!product) return res.status(404).json({ message: 'Product not found' });
    if (product.farmer.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    // Remove from Cloudinary
    const publicId = imageUrl.split('/').slice(-2).join('/').split('.')[0];
    await cloudinary.uploader.destroy(publicId);

    // Remove from product
    product.images = product.images.filter(img => img !== imageUrl);
    await product.save();

    res.json({ message: 'Image removed', product });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;