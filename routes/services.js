const Service = require('../models/service');
const jwt = require('jsonwebtoken');
const { wrapRoute } = require('../helpers/failureEmail');
const { createDashboardAuth } = require('../helpers/dashboardAuth');
const router = require('express').Router();

const validateClient = createDashboardAuth('services');

function servicePayload(body = {}, existing = null) {
  const out = {
    name: body.name !== undefined ? body.name : existing?.name,
    description: body.description !== undefined ? body.description : existing?.description,
    price: body.price !== undefined ? Number(body.price) : existing?.price,
  };
  if (body.duration !== undefined || !existing) {
    out.duration = Math.max(5, Number(body.duration ?? existing?.duration ?? 60) || 60);
  }
  if (body.isActive !== undefined || !existing) {
    out.isActive = body.isActive === undefined ? existing?.isActive ?? true : !!body.isActive;
  }
  if (body.category !== undefined) out.category = String(body.category || '').trim();
  if (body.image !== undefined) out.image = String(body.image || '');
  if (body.staffIds !== undefined) {
    out.staffIds = Array.isArray(body.staffIds) ? body.staffIds : [];
  }
  if (body.addonIds !== undefined) {
    out.addonIds = Array.isArray(body.addonIds) ? body.addonIds : [];
  }
  if (body.isPackage !== undefined) out.isPackage = !!body.isPackage;
  if (body.packageServiceIds !== undefined) {
    out.packageServiceIds = Array.isArray(body.packageServiceIds) ? body.packageServiceIds : [];
  }
  if (body.bufferBeforeMin !== undefined) {
    out.bufferBeforeMin = Math.max(0, Number(body.bufferBeforeMin) || 0);
  }
  if (body.bufferAfterMin !== undefined) {
    out.bufferAfterMin = Math.max(0, Number(body.bufferAfterMin) || 0);
  }
  return out;
}

router.post('/', validateClient, wrapRoute(async (req, res) => {
  const clientID = req.clientId;
  const payload = servicePayload(req.body, null);
  if (!payload.name || payload.price == null) {
    return res.status(400).json({ error: 'name and price are required' });
  }
  const newService = new Service({ ...payload, clientID });
  await newService.save();
  res.status(201).json({ message: 'Service created successfully', service: newService });
}));

router.get('/', validateClient, wrapRoute(async (req, res) => {
  const filter = { clientID: req.clientId };
  if (req.query.active === '1' || req.query.active === 'true') filter.isActive = true;
  if (req.query.category) filter.category = String(req.query.category);
  const services = await Service.find(filter).sort({ name: 1 });
  res.json(services);
}));

router.get('/:id', validateClient, wrapRoute(async (req, res) => {
  const service = await Service.findOne({ _id: req.params.id, clientID: req.clientId });
  if (!service) return res.status(404).json({ error: 'Service not found' });
  res.json(service);
}));

router.put('/:id', validateClient, wrapRoute(async (req, res) => {
  const existing = await Service.findOne({ _id: req.params.id, clientID: req.clientId });
  if (!existing) return res.status(404).json({ error: 'Service not found' });
  const payload = servicePayload(req.body, existing);
  Object.assign(existing, payload);
  await existing.save();
  res.json({ message: 'Service updated successfully', service: existing });
}));

router.delete('/:id', validateClient, wrapRoute(async (req, res) => {
  const deletedService = await Service.findOneAndDelete({ _id: req.params.id, clientID: req.clientId });
  if (!deletedService) return res.status(404).json({ error: 'Service not found' });
  res.json({ message: 'Service deleted successfully' });
}));

module.exports = router;
