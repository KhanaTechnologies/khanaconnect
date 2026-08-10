const SaasSocialPost = require('../../models/SaasSocialPost');
const MetaAdsService = require('../../services/saas/MetaAdsService');

async function processScheduledSocialPost(data = {}) {
  const clientId = String(data.clientId || data.client_id || '').trim();
  const postId = String(data.postId || data.socialPostId || '').trim();
  if (!clientId || !postId) throw new Error('clientId and postId are required');

  const post = await SaasSocialPost.findOne({ _id: postId, client_id: clientId });
  if (!post) throw new Error(`Scheduled social post not found: ${postId}`);
  if (post.status === 'cancelled') return { skipped: true, reason: 'cancelled' };
  if (post.status === 'published') return { skipped: true, reason: 'already_published' };

  post.status = 'publishing';
  post.lastError = '';
  await post.save();

  try {
    const results = await MetaAdsService.publishSocialPost(clientId, {
      destinations: post.destinations,
      mediaType: post.mediaType,
      caption: post.caption,
      imageUrls: post.imageUrls,
      imageUrl: post.imageUrls?.[0] || '',
      videoUrl: post.videoUrl,
    });

    const hasOk = !!(results.facebook || results.instagram);
    const hasErr = Array.isArray(results.errors) && results.errors.length > 0;
    post.results = results;
    post.publishedAt = new Date();
    post.agendaJobId = '';
    post.status = hasOk && hasErr ? 'partial' : hasOk ? 'published' : 'failed';
    post.lastError = hasErr ? results.errors.map((e) => `${e.platform}: ${e.message}`).join(' | ') : '';
    await post.save();
    return results;
  } catch (err) {
    post.status = 'failed';
    post.lastError = err.message || 'Publish failed';
    post.agendaJobId = '';
    await post.save();
    throw err;
  }
}

module.exports = { processScheduledSocialPost };
