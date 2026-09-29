import net from 'node:net';

const services = [
  ['CRM UI', 5173],
  ['CRM API', 3001],
  ['CMS mock', 3101],
  ['LMS mock', 3102],
];

async function isListening(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (error) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error(`Проверка порта ${port} не завершилась вовремя`));
    });
  });
}

try {
  const occupied = [];
  for (const [service, port] of services) {
    if (await isListening(port)) occupied.push(`${service}: ${port}`);
  }
  if (occupied.length) {
    console.error(`Локальные порты уже заняты (${occupied.join(', ')}). Проверьте ранее запущенный стенд и остановите его перед повторным ./run-local.sh.`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Не удалось проверить локальные порты: ${error.message}`);
  process.exitCode = 1;
}
