// A free TCP port on 127.0.0.1, for a test that must know its port before it binds (a server that it starts as its
// own process, or one whose Origin check is made before the server). The system picks the port with a bind to port 0,
// and the bind is closed at once. It comes from the system's ephemeral range, so it never meets the fixed ports that
// the scripted click-throughs and the review harnesses use. A test whose server runs in the test process binds port 0
// itself and reads `server.port`.

export function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}
