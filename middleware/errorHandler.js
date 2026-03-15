const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch((error) => {
    console.error('Async error:', error);
    
    // Handle specific MongoDB errors
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        error: 'Validation Error',
        details: Object.values(error.errors).map(e => e.message)
      });
    }

    if (error.code === 11000) {
      return res.status(409).json({
        error: 'Duplicate event detected',
        message: 'This event has already been recorded'
      });
    }

    // Default error
    res.status(500).json({
      error: 'Internal Server Error',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  });
};

module.exports = asyncHandler;