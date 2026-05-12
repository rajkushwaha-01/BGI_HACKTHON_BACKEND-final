const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const User = require('../models/User');
const { protect, restrictTo } = require('../middleware/auth');
const {
  optimizeRoute,
  recalculateRoute,
  haversineDistance
} = require('../ai/deliveryCluster');

// ============================================================
// @route   GET /api/delivery/my-batches
// @desc    Delivery person gets all their assigned batches
//          with optimized routes
// @access  Delivery only
// ============================================================
router.get(
  '/my-batches',
  protect,
  restrictTo('delivery'),
  async (req, res) => {
    try {
      // Get all orders assigned to this delivery person
      const orders = await Order.find({
        deliveryPerson: req.user._id,
        status: { $in: ['assigned', 'out_for_delivery'] }
      })
        .populate('consumer', 'name phone')
        .populate('farmer', 'name farmName phone location')
        .populate('items.product', 'name images unit')
        .lean();

      if (!orders.length) {
        return res.json({
          batches: [],
          message: 'No active deliveries assigned to you'
        });
      }

      // Group orders by clusterId
      const batchMap = {};
      orders.forEach(order => {
        const key = order.clusterId || `single_${order._id}`;
        if (!batchMap[key]) {
          batchMap[key] = {
            clusterId: key,
            isSingle: !order.clusterId,
            farmer: order.farmer,
            orders: []
          };
        }
        batchMap[key].orders.push(order);
      });

      // Build optimized route for each batch
      const batches = await Promise.all(
        Object.values(batchMap).map(async batch => {
          const farmer = await User.findById(
            batch.farmer._id || batch.farmer
          ).select('location name farmName phone');

          const farmerCoords = farmer?.location?.coordinates || [0, 0];

          // Get optimized route
          const route = optimizeRoute(farmerCoords, batch.orders);

          // Calculate total items in batch
          const totalItems = batch.orders.reduce(
            (sum, o) => sum + o.items.length,
            0
          );

          // Calculate total earnings for delivery person
          // (₹20 per km as delivery incentive)
          const deliveryEarnings =
            Math.round(route.totalDistance * 20 * 100) / 100;

          return {
            clusterId: batch.clusterId,
            isSingle: batch.isSingle,
            farmer: {
              name: farmer?.name,
              farmName: farmer?.farmName,
              phone: farmer?.phone,
              coordinates: farmerCoords
            },
            orderCount: batch.orders.length,
            totalItems,
            route,
            deliveryEarnings,
            status: batch.orders[0]?.status,
            summary: {
              totalDistance: route.totalDistance,
              estimatedTimeMinutes: route.estimatedTimeMinutes,
              totalOrders: batch.orders.length,
              stops: route.stops?.length || 0
            }
          };
        })
      );

      // Sort: out_for_delivery first, then assigned
      batches.sort((a, b) => {
        if (a.status === 'out_for_delivery') return -1;
        if (b.status === 'out_for_delivery') return 1;
        return 0;
      });

      res.json({
        batches,
        totalBatches: batches.length,
        totalOrders: orders.length
      });
    } catch (error) {
      console.error('Get batches error:', error);
      res.status(500).json({ message: 'Server error', error: error.message });
    }
  }
);

// ============================================================
// @route   GET /api/delivery/batch/:clusterId/route
// @desc    Get full optimized route for a specific batch
// @access  Delivery only
// ============================================================
router.get(
  '/batch/:clusterId/route',
  protect,
  restrictTo('delivery'),
  async (req, res) => {
    try {
      const { clusterId } = req.params;

      const orders = await Order.find({
        clusterId,
        deliveryPerson: req.user._id
      })
        .populate('consumer', 'name phone')
        .populate('farmer', 'name farmName phone location')
        .lean();

      if (!orders.length) {
        return res.status(404).json({ message: 'Batch not found' });
      }

      const farmer = await User.findById(orders[0].farmer._id).select(
        'location name farmName phone'
      );

      const farmerCoords = farmer.location.coordinates;

      // Filter only undelivered orders for route
      const pendingOrders = orders.filter(o => o.status !== 'delivered');
      const deliveredOrders = orders.filter(o => o.status === 'delivered');

      const route = optimizeRoute(farmerCoords, pendingOrders);

      // Build full waypoints list for map
      const waypoints = [
        {
          type: 'start',
          label: 'Farmer (Start)',
          labelHindi: 'किसान (शुरुआत)',
          name: farmer.farmName || farmer.name,
          phone: farmer.phone,
          coordinates: farmerCoords,
          stopNumber: 0
        },
        ...(route.stops || []).map(stop => ({
          type: 'delivery',
          label: `Stop ${stop.stopNumber}`,
          labelHindi: `पड़ाव ${stop.stopNumber}`,
          name: stop.consumerName,
          phone: stop.order?.consumer?.phone,
          address: stop.address,
          city: stop.city,
          coordinates: stop.coordinates,
          stopNumber: stop.stopNumber,
          orderId: stop.orderId,
          distanceFromPrev: stop.distanceFromPrev,
          cumulativeDistance: stop.cumulativeDistance,
          isDelivered: false
        })),
        ...deliveredOrders.map(o => ({
          type: 'delivered',
          label: 'Delivered',
          labelHindi: 'डिलीवर हो गया',
          name: o.consumer?.name,
          address: o.deliveryAddress?.address,
          city: o.deliveryAddress?.city,
          coordinates: o.deliveryAddress?.location?.coordinates,
          orderId: o._id,
          isDelivered: true
        }))
      ];

      res.json({
        clusterId,
        farmer: {
          name: farmer.name,
          farmName: farmer.farmName,
          phone: farmer.phone,
          coordinates: farmerCoords
        },
        route,
        waypoints,
        totalOrders: orders.length,
        pendingCount: pendingOrders.length,
        deliveredCount: deliveredOrders.length,
        progress:
          Math.round((deliveredOrders.length / orders.length) * 100) + '%'
      });
    } catch (error) {
      console.error('Get route error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// ============================================================
// @route   PUT /api/delivery/order/:id/deliver
// @desc    Mark a single order as delivered
//          Recalculates route for remaining stops
// @access  Delivery only
// ============================================================
router.put(
  '/order/:id/deliver',
  protect,
  restrictTo('delivery'),
  async (req, res) => {
    try {
      const { currentLongitude, currentLatitude } = req.body;

      const order = await Order.findById(req.params.id);

      if (!order) {
        return res.status(404).json({ message: 'Order not found' });
      }

      if (order.deliveryPerson.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: 'Not authorized' });
      }

      if (order.status === 'delivered') {
        return res.status(400).json({ message: 'Order already delivered' });
      }

      // Mark as delivered
      order.status = 'delivered';
      order.deliveredAt = new Date();
      order.paymentStatus = 'paid';
      order.statusHistory.push({
        status: 'delivered',
        timestamp: new Date(),
        note: 'Delivered by delivery person'
      });

      await order.save();

      // Recalculate route for remaining orders in batch
      let updatedRoute = null;

      if (order.clusterId && currentLongitude && currentLatitude) {
        const remainingOrders = await Order.find({
          clusterId: order.clusterId,
          status: { $nin: ['delivered', 'cancelled'] },
          deliveryPerson: req.user._id
        }).lean();

        if (remainingOrders.length > 0) {
          const currentCoords = [
            parseFloat(currentLongitude),
            parseFloat(currentLatitude)
          ];
          updatedRoute = recalculateRoute(currentCoords, remainingOrders);
        }
      }

      res.json({
        message: 'Order marked as delivered!',
        order,
        updatedRoute,
        remainingInBatch: updatedRoute?.stops?.length || 0
      });
    } catch (error) {
      console.error('Deliver order error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// ============================================================
// @route   PUT /api/delivery/batch/:clusterId/start
// @desc    Delivery person starts a batch (out_for_delivery)
// @access  Delivery only
// ============================================================
router.put(
  '/batch/:clusterId/start',
  protect,
  restrictTo('delivery'),
  async (req, res) => {
    try {
      const { clusterId } = req.params;

      const result = await Order.updateMany(
        {
          clusterId,
          deliveryPerson: req.user._id,
          status: 'assigned'
        },
        {
          $set: { status: 'out_for_delivery' },
          $push: {
            statusHistory: {
              status: 'out_for_delivery',
              timestamp: new Date(),
              note: 'Delivery started'
            }
          }
        }
      );

      if (result.modifiedCount === 0) {
        return res.status(400).json({
          message: 'No orders to start or batch already started'
        });
      }

      res.json({
        message: `Delivery started for ${result.modifiedCount} orders`,
        modifiedCount: result.modifiedCount
      });
    } catch (error) {
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// ============================================================
// @route   GET /api/delivery/available-persons
// @desc    Get all available delivery persons
//          Optionally filter by proximity to farmer
// @access  Farmer or Admin
// ============================================================
router.get(
  '/available-persons',
  protect,
  restrictTo('farmer', 'admin'),
  async (req, res) => {
    try {
      const { longitude, latitude } = req.query;

      let deliveryPersons;

      if (longitude && latitude) {
        // Find nearest delivery persons using geospatial query
        deliveryPersons = await User.aggregate([
          {
            $geoNear: {
              near: {
                type: 'Point',
                coordinates: [parseFloat(longitude), parseFloat(latitude)]
              },
              distanceField: 'distanceFromFarmer',
              distanceMultiplier: 0.001,
              spherical: true,
              query: { role: 'delivery', isActive: true }
            }
          },
          { $limit: 10 },
          {
            $project: {
              name: 1,
              phone: 1,
              location: 1,
              distanceFromFarmer: {
                $round: ['$distanceFromFarmer', 1]
              }
            }
          }
        ]);
      } else {
        deliveryPersons = await User.find({
          role: 'delivery',
          isActive: true
        }).select('name phone location');
      }

      // Add active order count for each delivery person
      const personsWithLoad = await Promise.all(
        deliveryPersons.map(async person => {
          const activeOrders = await Order.countDocuments({
            deliveryPerson: person._id,
            status: { $in: ['assigned', 'out_for_delivery'] }
          });

          return {
            ...person,
            activeOrders,
            availability:
              activeOrders === 0
                ? 'available'
                : activeOrders < 3
                ? 'busy'
                : 'fully_loaded'
          };
        })
      );

      // Sort: available first
      personsWithLoad.sort((a, b) => a.activeOrders - b.activeOrders);

      res.json({
        deliveryPersons: personsWithLoad,
        count: personsWithLoad.length
      });
    } catch (error) {
      console.error('Get delivery persons error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// ============================================================
// @route   GET /api/delivery/stats
// @desc    Delivery person's earnings and performance stats
// @access  Delivery only
// ============================================================
router.get(
  '/stats',
  protect,
  restrictTo('delivery'),
  async (req, res) => {
    try {
      const deliveryPersonId = req.user._id;

      // Total delivered orders
      const totalDelivered = await Order.countDocuments({
        deliveryPerson: deliveryPersonId,
        status: 'delivered'
      });

      // This month's deliveries
      const currentMonth = new Date().getMonth() + 1;
      const currentYear = new Date().getFullYear();

      const monthlyDelivered = await Order.countDocuments({
        deliveryPerson: deliveryPersonId,
        status: 'delivered',
        deliveredAt: {
          $gte: new Date(currentYear, currentMonth - 1, 1)
        }
      });

      // Calculate estimated earnings (₹20 per delivery)
      const estimatedEarnings = totalDelivered * 20;
      const monthlyEarnings = monthlyDelivered * 20;

      // Recent deliveries
      const recentDeliveries = await Order.find({
        deliveryPerson: deliveryPersonId,
        status: 'delivered'
      })
        .sort({ deliveredAt: -1 })
        .limit(5)
        .populate('consumer', 'name')
        .populate('farmer', 'name farmName')
        .select('totalAmount deliveredAt deliveryAddress clusterId');

      // Active assignments
      const activeAssignments = await Order.countDocuments({
        deliveryPerson: deliveryPersonId,
        status: { $in: ['assigned', 'out_for_delivery'] }
      });

      res.json({
        stats: {
          totalDelivered,
          monthlyDelivered,
          estimatedEarnings,
          monthlyEarnings,
          activeAssignments
        },
        recentDeliveries
      });
    } catch (error) {
      res.status(500).json({ message: 'Server error' });
    }
  }
);

module.exports = router;