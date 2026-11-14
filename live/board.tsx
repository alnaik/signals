import type { BoardFeature } from "../board/slots.ts";

const live: BoardFeature = {
  name: "live",
  connect: (store) => {
    let dropped = false;
    const es = new EventSource("/api/events");
    es.onopen = () => {
      store.setLive(true);
      // Back after sleep or a restart: anything may have changed, so refetch the whole queue.
      if (dropped) store.refetchAll();
      dropped = false;
    };
    es.onerror = () => {
      dropped = true;
      store.setLive(false);
    };
    es.addEventListener("thread.changed", (e) =>
      store.refetchThread(JSON.parse((e as MessageEvent).data).id),
    );
    es.addEventListener("rail.changed", () => {
      store.refetchAll();
      window.dispatchEvent(new Event("rail.changed"));
    });
    es.addEventListener("work.progress", (e) =>
      window.dispatchEvent(
        new CustomEvent("work.progress", { detail: JSON.parse((e as MessageEvent).data) }),
      ),
    );
    es.addEventListener("add.progress", (e) =>
      window.dispatchEvent(new CustomEvent("add.progress", { detail: JSON.parse((e as MessageEvent).data) })),
    );
    es.addEventListener("refresh.progress", (e) =>
      window.dispatchEvent(
        new CustomEvent("refresh.progress", { detail: JSON.parse((e as MessageEvent).data) }),
      ),
    );
    es.addEventListener("toast", (e) =>
      window.dispatchEvent(new CustomEvent("toast", { detail: JSON.parse((e as MessageEvent).data).text })),
    );
    es.addEventListener("watchlist.changed", () => window.dispatchEvent(new Event("watchlist.changed")));
    es.addEventListener("inbox.changed", () => {
      store.refetchInbox();
      window.dispatchEvent(new Event("inbox.changed"));
    });
    return () => es.close();
  },
};

export default live;
