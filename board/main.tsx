import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { framed } from "./format.ts";

// Never inside another page's frame: a site could lay the board under its own buttons and steer
// your clicks onto Work (it spends money), Dismiss or Apply. Its requests would come from the
// board's own origin, so the server can't tell them apart.
if (framed(window)) document.body.textContent = "Signal Board only opens in its own tab.";
else createRoot(document.getElementById("root")!).render(<App />);
