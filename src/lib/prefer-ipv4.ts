import { setDefaultResultOrder } from "dns";
import { setDefaultAutoSelectFamily } from "net";

// Force outbound connections to use IPv4. Side-effect import — run at
// process start before any HTTP client is created.
//
// Root cause: our outbound traffic egresses through a Tailscale exit
// node (a macOS home device). That exit node reliably forwards IPv4
// but IPv6 forwarding is flaky — packets to Google's IPv6 addresses
// (youtube.com has AAAA records) time out silently. Node's undici
// (backing `fetch`) does Happy Eyeballs across families; when the
// IPv6 path hangs instead of refusing, the TCP connect stalls long
// past any practical timeout before falling through to IPv4.
//
// Two-part fix:
//   1. `setDefaultResultOrder("ipv4first")` — dns.lookup returns A
//      records before AAAA.
//   2. `setDefaultAutoSelectFamily(false)` — net.connect uses only
//      the FIRST resolved address, not Happy Eyeballs across all
//      addresses. Combined with (1), Node always picks the first
//      IPv4 address and never tries IPv6.
//
// Verified: before this init `fetch("https://www.youtube.com")` from
// the container ETIMEDOUT; after, it returns 200.
//
// If the exit-node IPv6 path ever becomes reliable, this can be
// removed without changing any caller code.
setDefaultResultOrder("ipv4first");
setDefaultAutoSelectFamily(false);
