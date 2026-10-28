import { REPLY_CAPABILITIES, type CommentRecord } from '@shipcast/engine';

/** A comment as the API and the page show it: whether it can be answered from here, and where to answer it otherwise */
export function commentView(comment: CommentRecord) {
  const capability = REPLY_CAPABILITIES[comment.channel];
  const canReply = capability?.reply ?? false;
  return { ...comment, canReply, ...(!canReply && comment.url && { replyOn: comment.url }) };
}
