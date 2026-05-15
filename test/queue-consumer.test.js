const assert = require("node:assert/strict");
const test = require("node:test");

process.env.QUEUE_CONSUMER_MOCK = "true";
process.env.QUEUE_MAX_DEQUEUE_COUNT = "3";
process.env.QUEUE_NAME = "minutes-jobs-test";

const queueConsumer = require("../services/queue-consumer");

test("shouldDeadLetter returns true when dequeue count reaches configured max", () => {
  assert.equal(queueConsumer.shouldDeadLetter({ dequeueCount: 1 }), false);
  assert.equal(queueConsumer.shouldDeadLetter({ dequeueCount: 2 }), false);
  assert.equal(queueConsumer.shouldDeadLetter({ dequeueCount: 3 }), true);
  assert.equal(queueConsumer.shouldDeadLetter({ dequeueCount: 4 }), true);
});

test("buildDeadLetterPayload preserves original message for diagnostics", () => {
  const payload = queueConsumer.buildDeadLetterPayload({
    messageId: "message-001",
    dequeueCount: 3,
    messageText: "base64-payload"
  }, "max_dequeue_exceeded");

  assert.equal(payload.reason, "max_dequeue_exceeded");
  assert.equal(payload.sourceQueue, "minutes-jobs-test");
  assert.equal(payload.messageId, "message-001");
  assert.equal(payload.dequeueCount, 3);
  assert.equal(payload.messageText, "base64-payload");
  assert.match(payload.deadLetteredAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("deadLetterMessage sends to DLQ and deletes original message", async () => {
  const sent = [];
  const deleted = [];
  const queue = {
    async deleteMessage(messageId, popReceipt) {
      deleted.push({ messageId, popReceipt });
    }
  };

  const oldDeadLetter = queueConsumer._setDeadLetterQueueClientForTest({
    async createIfNotExists() {},
    async sendMessage(messageText) {
      sent.push(messageText);
    }
  });

  try {
    await queueConsumer.deadLetterMessage(queue, {
      messageId: "message-002",
      popReceipt: "receipt-002",
      dequeueCount: 3,
      messageText: "original-message"
    }, "max_dequeue_exceeded");
  } finally {
    queueConsumer._setDeadLetterQueueClientForTest(oldDeadLetter);
  }

  assert.equal(sent.length, 1);
  const decoded = JSON.parse(Buffer.from(sent[0], "base64").toString("utf8"));
  assert.equal(decoded.messageText, "original-message");
  assert.deepEqual(deleted, [{ messageId: "message-002", popReceipt: "receipt-002" }]);
});
