const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const { protect, restrictTo } = require('../middleware/auth');

// --- Helper: Generate JWT ---
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '30d' });
};

// ============================================================
// @route   POST /api/auth/register
// @desc    Register a new user (farmer, consumer, delivery)
// @access  Public
// ============================================================
router.post(
  '/register',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('phone')
      .trim()
      .isLength({ min: 10, max: 10 })
      .withMessage('Valid 10-digit phone number is required'),
    body('password')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters'),
    body('role')
      .isIn(['farmer', 'consumer', 'delivery'])
      .withMessage('Role must be farmer, consumer, or delivery')
  ],
  async (req, res) => {
    // Validate inputs
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      name,
      email,
      phone,
      password,
      role,
      farmName,
      farmSizeAcres,
      deliveryRadiusKm,
      language,
      address,
      city,
      state,
      longitude,
      latitude
    } = req.body;

    try {
      // Check if user already exists
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(400).json({ message: 'Email already registered' });
      }

      // Build location object
      const location = {
        type: 'Point',
        coordinates: [
          parseFloat(longitude) || 0,
          parseFloat(latitude) || 0
        ],
        address: address || '',
        city: city || '',
        state: state || ''
      };

      // Create user
      const userData = {
        name,
        email,
        phone,
        password,
        role,
        location,
        language: language || 'en'
      };

      // Farmer-specific fields
      if (role === 'farmer') {
        userData.farmName = farmName || '';
        userData.farmSizeAcres = farmSizeAcres || 0;
        userData.deliveryRadiusKm = deliveryRadiusKm || 20;
        userData.isApproved = false; // Needs admin approval
      }

      const user = await User.create(userData);

      // Return token + user data
      res.status(201).json({
        message:
          role === 'farmer'
            ? 'Registration successful! Your account is pending admin approval.'
            : 'Registration successful!',
        token: generateToken(user._id),
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          role: user.role,
          language: user.language,
          location: user.location,
          isApproved: user.isApproved,
          deliveryRadiusKm: user.deliveryRadiusKm,
          farmName: user.farmName
        }
      });
    } catch (error) {
      console.error('Register error:', error);
      res.status(500).json({ message: 'Server error', error: error.message });
    }
  }
);

// ============================================================
// @route   POST /api/auth/login
// @desc    Login user
// @access  Public
// ============================================================
router.post(
  '/login',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').notEmpty().withMessage('Password is required')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    try {
      // Find user
      const user = await User.findOne({ email });
      if (!user) {
        return res.status(401).json({ message: 'Invalid email or password' });
      }

      // Check password
      const isMatch = await user.matchPassword(password);
      if (!isMatch) {
        return res.status(401).json({ message: 'Invalid email or password' });
      }

      // Check if account is active
      if (!user.isActive) {
        return res.status(403).json({ message: 'Account has been deactivated. Contact support.' });
      }

      res.json({
        message: 'Login successful',
        token: generateToken(user._id),
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          role: user.role,
          language: user.language,
          location: user.location,
          isApproved: user.isApproved,
          deliveryRadiusKm: user.deliveryRadiusKm,
          farmName: user.farmName,
          avatar: user.avatar,
          rating: user.rating
        }
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ message: 'Server error', error: error.message });
    }
  }
);

// ============================================================
// @route   GET /api/auth/me
// @desc    Get current logged in user
// @access  Private
// ============================================================
router.get('/me', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    res.json({ user });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// @route   PUT /api/auth/update-profile
// @desc    Update user profile
// @access  Private
// ============================================================
router.put('/update-profile', protect, async (req, res) => {
  try {
    const {
      name,
      phone,
      farmName,
      farmSizeAcres,
      deliveryRadiusKm,
      language,
      address,
      city,
      state,
      longitude,
      latitude
    } = req.body;

    const updateData = {};

    if (name) updateData.name = name;
    if (phone) updateData.phone = phone;
    if (language) updateData.language = language;
    if (farmName) updateData.farmName = farmName;
    if (farmSizeAcres) updateData.farmSizeAcres = farmSizeAcres;
    if (deliveryRadiusKm) updateData.deliveryRadiusKm = deliveryRadiusKm;

    // Update location if provided
    if (longitude && latitude) {
      updateData.location = {
        type: 'Point',
        coordinates: [parseFloat(longitude), parseFloat(latitude)],
        address: address || req.user.location.address,
        city: city || req.user.location.city,
        state: state || req.user.location.state
      };
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: updateData },
      { new: true }
    ).select('-password');

    res.json({ message: 'Profile updated successfully', user });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ============================================================
// @route   PUT /api/auth/change-password
// @desc    Change password
// @access  Private
// ============================================================
router.put('/change-password', protect, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    const user = await User.findById(req.user._id);
    const isMatch = await user.matchPassword(currentPassword);

    if (!isMatch) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }

    user.password = newPassword;
    await user.save();

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ============================================================
// @route   GET /api/auth/farmers (Admin only)
// @desc    Get all farmers with approval status
// @access  Admin
// ============================================================
router.get(
  '/farmers',
  protect,
  restrictTo('admin'),
  async (req, res) => {
    try {
      const { status } = req.query; // 'pending', 'approved', 'all'

      let query = { role: 'farmer' };
      if (status === 'pending') query.isApproved = false;
      if (status === 'approved') query.isApproved = true;

      const farmers = await User.find(query).select('-password').sort({ createdAt: -1 });
      res.json({ farmers, count: farmers.length });
    } catch (error) {
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// ============================================================
// @route   PUT /api/auth/approve-farmer/:id (Admin only)
// @desc    Approve or reject a farmer
// @access  Admin
// ============================================================
router.put(
  '/approve-farmer/:id',
  protect,
  restrictTo('admin'),
  async (req, res) => {
    try {
      const { approved } = req.body;

      const farmer = await User.findById(req.params.id);
      if (!farmer || farmer.role !== 'farmer') {
        return res.status(404).json({ message: 'Farmer not found' });
      }

      farmer.isApproved = approved;
      farmer.isActive = approved;
      await farmer.save();

      res.json({
        message: approved
          ? 'Farmer approved successfully'
          : 'Farmer rejected',
        farmer
      });
    } catch (error) {
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// ============================================================
// @route   GET /api/auth/all-users (Admin only)
// @desc    Get all users
// @access  Admin
// ============================================================
router.get(
  '/all-users',
  protect,
  restrictTo('admin'),
  async (req, res) => {
    try {
      const { role } = req.query;
      const query = role ? { role } : {};
      const users = await User.find(query)
        .select('-password')
        .sort({ createdAt: -1 });
      res.json({ users, count: users.length });
    } catch (error) {
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// ============================================================
// @route   PUT /api/auth/toggle-user/:id (Admin only)
// @desc    Activate or deactivate any user
// @access  Admin
// ============================================================
router.put(
  '/toggle-user/:id',
  protect,
  restrictTo('admin'),
  async (req, res) => {
    try {
      const user = await User.findById(req.params.id);
      if (!user) return res.status(404).json({ message: 'User not found' });

      user.isActive = !user.isActive;
      await user.save();

      res.json({
        message: `User ${user.isActive ? 'activated' : 'deactivated'} successfully`,
        user
      });
    } catch (error) {
      res.status(500).json({ message: 'Server error' });
    }
  }
);

module.exports = router;