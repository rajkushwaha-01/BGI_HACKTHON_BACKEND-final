const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const Product = require('../models/Product');
const PriceHistory = require('../models/PriceHistory');
const User = require('../models/User');
const { protect, restrictTo } = require('../middleware/auth');
const { createDeliveryBatches } = require('../ai/deliveryCluster');

// ============================================================
// @route   POST /api/orders
// @desc    Consumer places an order
// @access  Consumer only
// ============================================================
router.post('/', protect, restrictTo('consumer'), async (req, res) => {
  try {
    const {
      items,
      deliveryAddress,
      paymentMethod,
      consumerNote
    } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ message: 'No items in order' });
    }

    // Validate each item and check stock
    let subtotal = 0;
    const orderItems = [];
    let farmerId = null;

    for (const item of items) {
      const product = await Product.findById(item.productId);

      if (!product) {
        return res.status(404).json({
          message: `Product ${item.productId} not found`
        });
      }

      if (!product.isAvailable || product.quantityAvailable < item.quantity) {
        return res.status(400).json({
          message: `${product.name} is not available in requested quantity. Available: ${product.quantityAvailable} ${product.unit}`
        });
      }

      // Enforce single farmer per order
      if (farmerId && product.farmer.toString() !== farmerId.toString()) {
        return res.status(400).json({
          message: 'All items in one order must be from the same farmer. Please place separate orders for different farmers.'
        });
      }

      farmerId = product.farmer;

      const itemTotal = product.pricePerUnit * item.quantity;
      subtotal += itemTotal;

      orderItems.push({
        product: product._id,
        farmer: product.farmer,
        name: product.name,
        pricePerUnit: product.pricePerUnit,
        unit: product.unit,
        quantity: item.quantity,
        totalPrice: itemTotal,
        image: product.images[0] || ''
      });
    }

    // Calculate delivery charge (free above ₹500)
    const deliveryCharge = subtotal >= 500 ? 0 : 40;
    const totalAmount = subtotal + deliveryCharge;

    // Build delivery address with coordinates
    const deliveryLocation = {
      type: 'Point',
      coordinates: [
        parseFloat(deliveryAddress.longitude) || 0,
        parseFloat(deliveryAddress.latitude) || 0
      ]
    };

    // Create the order
    const order = await Order.create({
      consumer: req.user._id,
      farmer: farmerId,
      items: orderItems,
      deliveryAddress: {
        address: deliveryAddress.address,
        city: deliveryAddress.city,
        state: deliveryAddress.state,
        pincode: deliveryAddress.pincode,
        location: deliveryLocation
      },
      subtotal,
      deliveryCharge,
      totalAmount,
      paymentMethod: paymentMethod || 'cod',
      paymentStatus: paymentMethod === 'cod' ? 'pending' : 'pending',
      consumerNote: consumerNote || '',
      status: 'placed',
      statusHistory: [
        {
          status: 'placed',
          timestamp: new Date(),
          note: 'Order placed by consumer'
        }
      ],
      estimatedDelivery: getEstimatedDelivery()
    });

    // Deduct stock for each item
    for (const item of items) {
      const product = await Product.findById(item.productId);
      product.quantityAvailable -= item.quantity;

      // Auto mark out of stock
      if (product.quantityAvailable <= 0) {
        product.quantityAvailable = 0;
        product.isAvailable = false;
      }

      await product.save();

      // Record sale in price history for AI model
      await PriceHistory.findOneAndUpdate(
        {
          farmer: farmerId,
          cropName: product.name.toLowerCase(),
          month: new Date().getMonth() + 1,
          year: new Date().getFullYear()
        },
        {
          $inc: {
            quantitySold: item.quantity,
            ordersCount: 1,
            revenue: item.quantity * product.pricePerUnit
          }
        },
        { upsert: true }
      );
    }

    // Populate order for response
    const populatedOrder = await Order.findById(order._id)
      .populate('consumer', 'name phone email')
      .populate('farmer', 'name farmName phone');

    res.status(201).json({
      message: 'Order placed successfully!',
      order: populatedOrder
    });
  } catch (error) {
    console.error('Place order error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ============================================================
// @route   GET /api/orders/my-orders
// @desc    Consumer views their orders
// @access  Consumer only
// ============================================================
router.get(
  '/my-orders',
  protect,
  restrictTo('consumer'),
  async (req, res) => {
    try {
      const { status, page = 1, limit = 10 } = req.query;

      const query = { consumer: req.user._id };
      if (status) query.status = status;

      const orders = await Order.find(query)
        .populate('farmer', 'name farmName phone rating')
        .populate('items.product', 'name images')
        .sort({ createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit));

      const total = await Order.countDocuments(query);

      res.json({ orders, total, page: parseInt(page) });
    } catch (error) {
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// ============================================================
// @route   GET /api/orders/farmer-orders
// @desc    Farmer views incoming orders
// @access  Farmer only
// ============================================================
router.get(
  '/farmer-orders',
  protect,
  restrictTo('farmer'),
  async (req, res) => {
    try {
      const { status, page = 1, limit = 10 } = req.query;

      const query = { farmer: req.user._id };
      if (status) query.status = status;

      const orders = await Order.find(query)
        .populate('consumer', 'name phone email location')
        .populate('items.product', 'name images unit')
        .sort({ createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit));

      const total = await Order.countDocuments(query);

      // Summary counts
      const summary = await Order.aggregate([
        { $match: { farmer: req.user._id } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]);

      res.json({ orders, total, page: parseInt(page), summary });
    } catch (error) {
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// ============================================================
// @route   GET /api/orders/delivery-orders
// @desc    Delivery person views assigned orders
// @access  Delivery only
// ============================================================
router.get(
  '/delivery-orders',
  protect,
  restrictTo('delivery'),
  async (req, res) => {
    try {
      const { status } = req.query;

      const query = { deliveryPerson: req.user._id };
      if (status) query.status = status;

      const orders = await Order.find(query)
        .populate('consumer', 'name phone')
        .populate('farmer', 'name farmName phone location')
        .populate('items.product', 'name images')
        .sort({ createdAt: -1 });

      res.json({ orders, count: orders.length });
    } catch (error) {
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// ============================================================
// @route   GET /api/orders/:id
// @desc    Get single order details
// @access  Private (owner, farmer, delivery, admin)
// ============================================================
router.get('/:id', protect, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('consumer', 'name phone email location')
      .populate('farmer', 'name farmName phone location')
      .populate('deliveryPerson', 'name phone')
      .populate('items.product', 'name images unit category');

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    // Access control
    const userId = req.user._id.toString();
    const isOwner = order.consumer._id.toString() === userId;
    const isFarmer = order.farmer._id.toString() === userId;
    const isDelivery = order.deliveryPerson?._id?.toString() === userId;
    const isAdmin = req.user.role === 'admin';

    if (!isOwner && !isFarmer && !isDelivery && !isAdmin) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    res.json({ order });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// @route   PUT /api/orders/:id/status
// @desc    Update order status (farmer/delivery/admin)
// @access  Private
// ============================================================
router.put('/:id/status', protect, async (req, res) => {
  try {
    const { status, note } = req.body;

    const validStatuses = [
      'confirmed',
      'packed',
      'assigned',
      'out_for_delivery',
      'delivered',
      'cancelled'
    ];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    const userId = req.user._id.toString();
    const isFarmer = order.farmer.toString() === userId;
    const isDelivery = order.deliveryPerson?.toString() === userId;
    const isAdmin = req.user.role === 'admin';

    if (!isFarmer && !isDelivery && !isAdmin) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    // Status transition rules
    const farmerAllowed = ['confirmed', 'packed', 'cancelled'];
    const deliveryAllowed = ['out_for_delivery', 'delivered'];

    if (isFarmer && !farmerAllowed.includes(status)) {
      return res.status(400).json({
        message: `Farmer can only set: ${farmerAllowed.join(', ')}`
      });
    }

    if (isDelivery && !deliveryAllowed.includes(status)) {
      return res.status(400).json({
        message: `Delivery person can only set: ${deliveryAllowed.join(', ')}`
      });
    }

    order.status = status;
    order.statusHistory.push({
      status,
      timestamp: new Date(),
      note: note || ''
    });

    if (status === 'delivered') {
      order.deliveredAt = new Date();
      order.paymentStatus = 'paid';
    }

    if (status === 'cancelled') {
      order.cancelledAt = new Date();
      order.cancellationReason = note || '';

      // Restore stock
      for (const item of order.items) {
        await Product.findByIdAndUpdate(item.product, {
          $inc: { quantityAvailable: item.quantity },
          isAvailable: true
        });
      }
    }

    await order.save();

    res.json({ message: `Order status updated to ${status}`, order });
  } catch (error) {
    console.error('Update status error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// @route   POST /api/orders/create-batches
// @desc    Farmer triggers clustering of pending orders
// @access  Farmer only
// ============================================================
router.post(
  '/create-batches',
  protect,
  restrictTo('farmer'),
  async (req, res) => {
    try {
      const farmer = await User.findById(req.user._id);

      // Get all confirmed+packed orders for this farmer
      const orders = await Order.find({
        farmer: req.user._id,
        status: { $in: ['confirmed', 'packed'] },
        clusterId: null // not yet clustered
      }).populate('consumer', 'name phone');

      if (orders.length === 0) {
        return res.status(400).json({
          message: 'No eligible orders to cluster. Confirm orders first.'
        });
      }

      const farmerCoords = farmer.location.coordinates;
      const clusterRadiusKm = req.body.radiusKm || 5;

      // Run clustering + route optimization
      const result = createDeliveryBatches(
        orders,
        farmerCoords,
        clusterRadiusKm
      );

      // Save cluster IDs to orders
      for (const batch of result.batches) {
        await Order.updateMany(
          { _id: { $in: batch.orders } },
          {
            $set: {
              clusterId: batch.clusterId,
              status: 'assigned'
            },
            $push: {
              statusHistory: {
                status: 'assigned',
                timestamp: new Date(),
                note: `Clustered into batch ${batch.batchNumber}`
              }
            }
          }
        );
      }

      res.json({
        message: `${orders.length} orders clustered into ${result.totalBatches} delivery batches`,
        result
      });
    } catch (error) {
      console.error('Cluster orders error:', error);
      res.status(500).json({ message: 'Server error', error: error.message });
    }
  }
);

// ============================================================
// @route   PUT /api/orders/:id/assign-delivery
// @desc    Assign a delivery person to an order/batch
// @access  Farmer or Admin
// ============================================================
router.put(
  '/:id/assign-delivery',
  protect,
  restrictTo('farmer', 'admin'),
  async (req, res) => {
    try {
      const { deliveryPersonId } = req.body;

      const deliveryPerson = await User.findById(deliveryPersonId);
      if (!deliveryPerson || deliveryPerson.role !== 'delivery') {
        return res.status(400).json({ message: 'Invalid delivery person' });
      }

      const order = await Order.findById(req.params.id);
      if (!order) return res.status(404).json({ message: 'Order not found' });

      // If order is in a cluster, assign all orders in that cluster
      if (order.clusterId) {
        await Order.updateMany(
          { clusterId: order.clusterId },
          {
            $set: { deliveryPerson: deliveryPersonId },
            $push: {
              statusHistory: {
                status: order.status,
                timestamp: new Date(),
                note: `Assigned to ${deliveryPerson.name}`
              }
            }
          }
        );
        return res.json({
          message: `Entire batch assigned to ${deliveryPerson.name}`
        });
      }

      order.deliveryPerson = deliveryPersonId;
      order.statusHistory.push({
        status: order.status,
        timestamp: new Date(),
        note: `Assigned to ${deliveryPerson.name}`
      });
      await order.save();

      res.json({ message: `Order assigned to ${deliveryPerson.name}`, order });
    } catch (error) {
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// ============================================================
// @route   GET /api/orders/admin/all
// @desc    Admin views all orders
// @access  Admin only
// ============================================================
router.get(
  '/admin/all',
  protect,
  restrictTo('admin'),
  async (req, res) => {
    try {
      const { status, page = 1, limit = 20 } = req.query;
      const query = status ? { status } : {};

      const orders = await Order.find(query)
        .populate('consumer', 'name phone')
        .populate('farmer', 'name farmName')
        .populate('deliveryPerson', 'name phone')
        .sort({ createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit));

      const total = await Order.countDocuments(query);

      // Platform summary
      const summary = await Order.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]);

      res.json({ orders, total, page: parseInt(page), summary });
    } catch (error) {
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// --- Helper: Calculate estimated delivery (2 days from now) ---
function getEstimatedDelivery() {
  const date = new Date();
  date.setDate(date.getDate() + 2);
  return date;
}

module.exports = router;