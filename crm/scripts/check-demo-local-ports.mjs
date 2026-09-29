import net from 'node:net';

const services = [
  ['demo UI', 5174],
  ['demo API', 3003],
  ['demo CMS mock', 3103],
  ['demo LMS mock', 3104],
];

function isListening(port) {
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
      reject(new Error(`Port ${port} availability check timed out.`));
    });
  });
}

try {
  const occupied = [];
  for (const [service, port] of services) {
    if (await isListening(port)) occupied.push(`${service}: ${port}`);
  }
  if (occupied.length) {
    console.error(`Demo ports are already in use (${occupied.join(', ')}). Stop the other demo instance before retrying.`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Could not check demo ports: ${error.message}`);
  process.exitCode = 1;
}
