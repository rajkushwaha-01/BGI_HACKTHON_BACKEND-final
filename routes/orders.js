const express = require('express');
const router = express.Router();

const Order = require('../models/Order');
const Product = require('../models/Product');
const PriceHistory = require('../models/PriceHistory');
const User = require('../models/User');

const { protect, restrictTo } = require('../middleware/auth');
const { createDeliveryBatches } = require('../ai/deliveryCluster');

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
      return res.status(400).json({
        message: 'Invalid status'
      });
    }

    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({
        message: 'Order not found'
      });
    }

    const userId = req.user._id.toString();

    const isFarmer = order.farmer.toString() === userId;
    const isDelivery = order.deliveryPerson?.toString() === userId;
    const isAdmin = req.user.role === 'admin';

    if (!isFarmer && !isDelivery && !isAdmin) {
      return res.status(403).json({
        message: 'Not authorized'
      });
    }

    // ============================================================
    // STATUS RULES
    // ============================================================

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

    // ============================================================
    // UPDATE ORDER
    // ============================================================

    order.status = status;

    order.statusHistory.push({
      status,
      timestamp: new Date(),
      note: note || ''
    });

    // Delivered logic
    if (status === 'delivered') {
      order.deliveredAt = new Date();
      order.paymentStatus = 'paid';
    }

    // Cancelled logic
    if (status === 'cancelled') {
      order.cancelledAt = new Date();
      order.cancellationReason = note || '';

      // Restore stock
      for (const item of order.items) {
        await Product.findByIdAndUpdate(item.product, {
          $inc: {
            quantityAvailable: item.quantity
          },
          isAvailable: true
        });
      }
    }

    // Save order
    await order.save();

    // ============================================================
    // NOTIFICATIONS
    // ============================================================

    const consumer = await User.findById(order.consumer);

    if (consumer) {

      // Delivered notification
      if (status === 'delivered') {
        await consumer.pushNotification({
          title: '🎉 Order Delivered!',
          message: `Your order #${order._id
            .toString()
            .slice(-6)
            .toUpperCase()} has been delivered successfully.`,
          type: 'order_delivered',
          link: `/orders/${order._id}`
        });
      }

      // Other status notifications
      const statusMessages = {
        confirmed: {
          title: '✅ Order Confirmed',
          message: 'Your order has been confirmed by the farmer.'
        },

        packed: {
          title: '📦 Order Packed',
          message: 'Your order has been packed and is ready for dispatch.'
        },

        out_for_delivery: {
          title: '🚚 Out for Delivery',
          message: 'Your order is out for delivery and will arrive soon.'
        },

        cancelled: {
          title: '❌ Order Cancelled',
          message: 'Your order has been cancelled.'
        }
      };

      if (statusMessages[status]) {
        await consumer.pushNotification({
          title: statusMessages[status].title,
          message: statusMessages[status].message,
          type: 'order_status_update',
          link: `/orders/${order._id}`
        });
      }
    }

    // ============================================================
    // RESPONSE
    // ============================================================

    res.json({
      message: `Order status updated to ${status}`,
      order
    });

  } catch (error) {

    console.error('Update status error:', error);

    res.status(500).json({
      message: 'Server error',
      error: error.message
    });
  }
});

module.exports = router;