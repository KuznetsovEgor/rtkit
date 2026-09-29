import { startLmsMock } from './mock-services.js';

const mock = await startLmsMock();
console.log(`Local LMS mock listening at ${mock.url}`);
const shutdown = () => void mock.close().then(() => process.exit(0));
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
