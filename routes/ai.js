const express = require('express');
const router = express.Router();
const { protect, restrictTo } = require('../middleware/auth');
const { predictPrice, getFarmerPriceSummary } = require('../ai/pricePredictor');
const PriceHistory = require('../models/PriceHistory');
const Order = require('../models/Order');
const Product = require('../models/Product');

// ============================================================
// @route   POST /api/ai/predict-price
// @desc    Get AI price suggestion for a crop
// @access  Farmer only
// ============================================================
router.post(
  '/predict-price',
  protect,
  restrictTo('farmer'),
  async (req, res) => {
    try {
      const { cropName, unit } = req.body;

      if (!cropName) {
        return res.status(400).json({ message: 'Crop name is required' });
      }

      const prediction = await predictPrice(
        req.user._id,
        cropName.trim(),
        unit || 'kg'
      );

      res.json(prediction);
    } catch (error) {
      console.error('AI predict error:', error);
      res.status(500).json({ message: 'Prediction failed', error: error.message });
    }
  }
);

// ============================================================
// @route   GET /api/ai/price-summary
// @desc    Get farmer's full price history summary
// @access  Farmer only
// ============================================================
router.get(
  '/price-summary',
  protect,
  restrictTo('farmer'),
  async (req, res) => {
    try {
      const summary = await getFarmerPriceSummary(req.user._id);
      res.json(summary);
    } catch (error) {
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// ============================================================
// @route   GET /api/ai/price-history/:cropName
// @desc    Get price history chart data for a crop
// @access  Farmer only
// ============================================================
router.get(
  '/price-history/:cropName',
  protect,
  restrictTo('farmer'),
  async (req, res) => {
    try {
      const { cropName } = req.params;
      const { scope } = req.query; // 'mine' or 'platform'

      const query =
        scope === 'platform'
          ? { cropName: cropName.toLowerCase() }
          : { cropName: cropName.toLowerCase(), farmer: req.user._id };

      const history = await PriceHistory.find(query)
        .sort({ createdAt: 1 })
        .select('pricePerUnit month year quantitySold revenue createdAt source')
        .lean();

      if (!history.length) {
        return res.json({
          history: [],
          message: 'No price history found for this crop'
        });
      }

      // Format for chart
      const chartData = history.map(h => ({
        date: h.createdAt,
        price: h.pricePerUnit,
        quantitySold: h.quantitySold || 0,
        revenue: h.revenue || 0,
        month: h.month,
        year: h.year,
        source: h.source
      }));

      // Monthly averages for trend line
      const monthlyAverages = {};
      history.forEach(h => {
        const key = `${h.year}-${h.month}`;
        if (!monthlyAverages[key]) {
          monthlyAverages[key] = { prices: [], month: h.month, year: h.year };
        }
        monthlyAverages[key].prices.push(h.pricePerUnit);
      });

      const trendLine = Object.entries(monthlyAverages).map(([key, val]) => ({
        label: `${val.year}-${String(val.month).padStart(2, '0')}`,
        avgPrice:
          Math.round(
            (val.prices.reduce((a, b) => a + b, 0) / val.prices.length) * 100
          ) / 100
      }));

      res.json({ history: chartData, trendLine, total: history.length });
    } catch (error) {
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// ============================================================
// @route   GET /api/ai/market-trends
// @desc    Platform-wide price trends by category
// @access  Farmer only
// ============================================================
router.get(
  '/market-trends',
  protect,
  restrictTo('farmer'),
  async (req, res) => {
    try {
      const currentMonth = new Date().getMonth() + 1;
      const currentYear = new Date().getFullYear();
      const lastMonth = currentMonth === 1 ? 12 : currentMonth - 1;
      const lastMonthYear = currentMonth === 1 ? currentYear - 1 : currentYear;

      // Current month average prices per crop
      const currentMonthPrices = await PriceHistory.aggregate([
        { $match: { month: currentMonth, year: currentYear } },
        {
          $group: {
            _id: '$cropName',
            avgPrice: { $avg: '$pricePerUnit' },
            totalSold: { $sum: '$quantitySold' },
            count: { $sum: 1 }
          }
        },
        { $sort: { totalSold: -1 } },
        { $limit: 10 }
      ]);

      // Last month average prices for comparison
      const lastMonthPrices = await PriceHistory.aggregate([
        { $match: { month: lastMonth, year: lastMonthYear } },
        {
          $group: {
            _id: '$cropName',
            avgPrice: { $avg: '$pricePerUnit' }
          }
        }
      ]);

      const lastMonthMap = {};
      lastMonthPrices.forEach(p => {
        lastMonthMap[p._id] = p.avgPrice;
      });

      // Merge and calculate change
      const trends = currentMonthPrices.map(crop => {
        const lastPrice = lastMonthMap[crop._id] || crop.avgPrice;
        const change = ((crop.avgPrice - lastPrice) / lastPrice) * 100;

        return {
          cropName: crop._id,
          avgPrice: Math.round(crop.avgPrice * 100) / 100,
          lastMonthAvg: Math.round(lastPrice * 100) / 100,
          percentChange: Math.round(change * 10) / 10,
          trend: change > 2 ? 'rising' : change < -2 ? 'falling' : 'stable',
          totalSold: crop.totalSold,
          dataPoints: crop.count
        };
      });

      // Category-wise demand this month
      const categoryDemand = await Order.aggregate([
        {
          $match: {
            createdAt: {
              $gte: new Date(currentYear, currentMonth - 1, 1)
            },
            status: { $ne: 'cancelled' }
          }
        },
        { $unwind: '$items' },
        {
          $lookup: {
            from: 'products',
            localField: 'items.product',
            foreignField: '_id',
            as: 'productDetails'
          }
        },
        { $unwind: '$productDetails' },
        {
          $group: {
            _id: '$productDetails.category',
            totalOrders: { $sum: 1 },
            totalRevenue: { $sum: '$items.totalPrice' }
          }
        },
        { $sort: { totalOrders: -1 } }
      ]);

      res.json({
        trends,
        categoryDemand,
        month: currentMonth,
        year: currentYear
      });
    } catch (error) {
      console.error('Market trends error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// ============================================================
// @route   GET /api/ai/smart-suggestions
// @desc    Personalized suggestions for farmer dashboard
//          Based on their sales, pricing, and market trends
// @access  Farmer only
// ============================================================
router.get(
  '/smart-suggestions',
  protect,
  restrictTo('farmer'),
  async (req, res) => {
    try {
      const farmerId = req.user._id;
      const suggestions = [];

      // 1. Find out of stock products
      const outOfStock = await Product.find({
        farmer: farmerId,
        $or: [{ isAvailable: false }, { quantityAvailable: 0 }]
      }).select('name');

      if (outOfStock.length > 0) {
        suggestions.push({
          type: 'restock',
          priority: 'high',
          icon: '📦',
          en: `${outOfStock.map(p => p.name).join(', ')} ${outOfStock.length === 1 ? 'is' : 'are'} out of stock. Restock to keep earning.`,
          hi: `${outOfStock.map(p => p.name).join(', ')} का स्टॉक खत्म हो गया है। कमाई जारी रखने के लिए स्टॉक भरें।`
        });
      }

      // 2. Find low stock products
      const lowStock = await Product.find({
        farmer: farmerId,
        isAvailable: true,
        quantityAvailable: { $gt: 0, $lt: 10 }
      }).select('name quantityAvailable unit');

      if (lowStock.length > 0) {
        lowStock.forEach(p => {
          suggestions.push({
            type: 'low_stock',
            priority: 'medium',
            icon: '⚠️',
            en: `${p.name} is running low (${p.quantityAvailable} ${p.unit} left). Consider restocking soon.`,
            hi: `${p.name} का स्टॉक कम हो रहा है (${p.quantityAvailable} ${p.unit} बचा है)।`
          });
        });
      }

      // 3. Pending orders suggestion
      const pendingOrders = await Order.countDocuments({
        farmer: farmerId,
        status: 'placed'
      });

      if (pendingOrders > 0) {
        suggestions.push({
          type: 'pending_orders',
          priority: 'high',
          icon: '🛎️',
          en: `You have ${pendingOrders} new order${pendingOrders > 1 ? 's' : ''} waiting for confirmation. Confirm quickly to build trust.`,
          hi: `आपके पास ${pendingOrders} नए ऑर्डर पुष्टि की प्रतीक्षा में हैं। विश्वास बनाने के लिए जल्दी पुष्टि करें।`
        });
      }

      // 4. Check if farmer has set delivery radius
      const farmer = await require('../models/User')
        .findById(farmerId)
        .select('deliveryRadiusKm location');

      if (!farmer.location.coordinates[0] && !farmer.location.coordinates[1]) {
        suggestions.push({
          type: 'setup',
          priority: 'high',
          icon: '📍',
          en: 'Set your farm location to enable radius-based delivery filtering for consumers.',
          hi: 'उपभोक्ताओं के लिए त्रिज्या-आधारित डिलीवरी फ़िल्टरिंग सक्षम करने के लिए अपने खेत का स्थान सेट करें।'
        });
      }

      // 5. Revenue insight this month
      const currentMonth = new Date().getMonth() + 1;
      const currentYear = new Date().getFullYear();

      const monthRevenue = await Order.aggregate([
        {
          $match: {
            farmer: farmerId,
            status: 'delivered',
            createdAt: {
              $gte: new Date(currentYear, currentMonth - 1, 1)
            }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$totalAmount' },
            count: { $sum: 1 }
          }
        }
      ]);

      if (monthRevenue.length > 0 && monthRevenue[0].total > 0) {
        suggestions.push({
          type: 'revenue',
          priority: 'low',
          icon: '💰',
          en: `Great work! You've earned ₹${monthRevenue[0].total.toLocaleString('en-IN')} from ${monthRevenue[0].count} delivered orders this month.`,
          hi: `शानदार काम! आपने इस महीने ${monthRevenue[0].count} डिलीवर ऑर्डर से ₹${monthRevenue[0].total.toLocaleString('en-IN')} कमाए।`
        });
      }

      // 6. Suggest clustering if enough orders
      const clusterableOrders = await Order.countDocuments({
        farmer: farmerId,
        status: { $in: ['confirmed', 'packed'] },
        clusterId: null
      });

      if (clusterableOrders >= 3) {
        suggestions.push({
          type: 'clustering',
          priority: 'medium',
          icon: '🗺️',
          en: `You have ${clusterableOrders} confirmed orders. Create delivery batches to save time and fuel costs.`,
          hi: `आपके पास ${clusterableOrders} पुष्टि किए गए ऑर्डर हैं। समय और ईंधन बचाने के लिए डिलीवरी बैच बनाएं।`
        });
      }

      // Sort by priority
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      suggestions.sort(
        (a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]
      );

      res.json({
        suggestions,
        count: suggestions.length,
        farmerId
      });
    } catch (error) {
      console.error('Smart suggestions error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// ============================================================
// @route   GET /api/ai/admin-analytics
// @desc    Platform-wide analytics for admin dashboard
// @access  Admin only
// ============================================================
router.get(
  '/admin-analytics',
  protect,
  restrictTo('admin'),
  async (req, res) => {
    try {
      const User = require('../models/User');

      // Total counts
      const [
        totalFarmers,
        pendingFarmers,
        totalConsumers,
        totalProducts,
        totalOrders
      ] = await Promise.all([
        User.countDocuments({ role: 'farmer', isApproved: true }),
        User.countDocuments({ role: 'farmer', isApproved: false }),
        User.countDocuments({ role: 'consumer' }),
        Product.countDocuments({ isAvailable: true }),
        Order.countDocuments()
      ]);

      // Revenue last 6 months
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

      const revenueByMonth = await Order.aggregate([
        {
          $match: {
            status: 'delivered',
            createdAt: { $gte: sixMonthsAgo }
          }
        },
        {
          $group: {
            _id: {
              month: { $month: '$createdAt' },
              year: { $year: '$createdAt' }
            },
            revenue: { $sum: '$totalAmount' },
            orders: { $sum: 1 }
          }
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } }
      ]);

      // Top selling products
      const topProducts = await Order.aggregate([
        { $match: { status: { $ne: 'cancelled' } } },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.product',
            name: { $first: '$items.name' },
            totalSold: { $sum: '$items.quantity' },
            totalRevenue: { $sum: '$items.totalPrice' }
          }
        },
        { $sort: { totalSold: -1 } },
        { $limit: 5 }
      ]);

      // Order status breakdown
      const orderStatus = await Order.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]);

      res.json({
        counts: {
          totalFarmers,
          pendingFarmers,
          totalConsumers,
          totalProducts,
          totalOrders
        },
        revenueByMonth,
        topProducts,
        orderStatus
      });
    } catch (error) {
      console.error('Admin analytics error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

module.exports = router;