import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeDiscussion } from '../src/controllers/communityController.js';

const fixture = {
  id: 'thread-1',
  title: 'A thread title',
  ticker: '$BAG',
  category: 'GENERAL',
  content: 'This is the full thread body with research and details that should be available only to members.',
  upvotes: 0,
  downvotes: 0,
  isPinned: false,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  communityId: 'general',
  community: { slug: 'general', name: 'General' },
  author: { username: 'ThreadAuthor' },
  votes: [
    { userId: 'member-1', type: 'UP' },
    { userId: 'member-2', type: 'DOWN' },
  ],
  comments: [
    { id: 'c1', authorId: 'reader-1', content: 'My comment', displayMode: 'VISIBLE', createdAt: new Date(), author: { username: 'VisibleUser' } },
    { id: 'c2', authorId: 'reader-2', content: 'A different member reply', displayMode: 'VISIBLE', createdAt: new Date(), author: { username: 'OtherUser' } },
    { id: 'c3', authorId: 'reader-3', content: 'An anonymous reply', displayMode: 'ANONYMOUS', createdAt: new Date(), author: { username: 'SecretUser' } },
  ],
};

test('non-member receives a preview and only their own comment', () => {
  const result = serializeDiscussion(fixture, { userId: 'reader-1', isMember: false });
  assert.equal(result.previewOnly, true);
  assert.equal(result.content, undefined);
  assert.match(result.previewText, /Join this community/);
  assert.deepEqual(result.comments.map((comment) => comment.content), ['My comment']);
  assert.equal(result.commentCount, 1);
  assert.equal(JSON.stringify(result).includes('A different member reply'), false);
  assert.equal(JSON.stringify(result).includes('full thread body'), false);
});

test('member receives the full thread and all comments with anonymous names masked', () => {
  const result = serializeDiscussion(fixture, { userId: 'member-1', isMember: true });
  assert.equal(result.previewOnly, false);
  assert.equal(result.content, fixture.content);
  assert.equal(result.comments.length, 3);
  assert.equal(result.comments[0].authorName, 'VisibleUser');
  assert.equal(result.comments[2].authorName, 'Anonymous member');
  assert.equal(JSON.stringify(result).includes('SecretUser'), false);
  assert.equal(result.upvotes, 1);
  assert.equal(result.downvotes, 1);
  assert.equal(result.userVoted, 'UP');
});