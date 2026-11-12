import type {
  CatalogClient,
  ClientHost,
  Piece,
  UserSummary,
} from "./host.js";

/** A custom client is a function that receives its capabilities and returns a DOM node. */
export type ClientApi = ClientHost;
export type ClientFactory = (api: ClientApi) => HTMLElement | Promise<HTMLElement>;

export interface DomInputControl<T = string> {
  element: HTMLElement;
  getValue(): T;
  setValue(value: T): void;
  destroy(): void;
}

function appendChildren(parent: Node, ...children: Node[]): void {
  for (const child of children) parent.appendChild(child);
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export function createPieceDisplay(options: {
  catalog: CatalogClient;
  pieceId: string;
  className?: string;
}): HTMLElement {
  const root = element("span", options.className ?? "rl-piece");
  let live = true;
  options.catalog.getPiece(options.pieceId).then((piece) => {
    if (!live) return;
    root.textContent = "";
    if (!piece) {
      root.textContent = options.pieceId;
      return;
    }
    if (piece.imageUrl) {
      const image = element("img");
      image.src = piece.imageUrl;
      image.alt = "";
      image.width = 24;
      image.height = 24;
      appendChildren(root, image, document.createTextNode(" "));
    }
    if (piece.url) {
      const link = element("a");
      link.href = piece.url;
      link.textContent = piece.title;
      appendChildren(root, link);
    } else {
      appendChildren(root, document.createTextNode(piece.title));
    }
  });
  return root;
}

export function createUserDisplay(options: {
  catalog: CatalogClient;
  userId: string;
  className?: string;
}): HTMLElement {
  const root = element("span", options.className ?? "rl-user");
  let live = true;
  options.catalog.getUser(options.userId).then((user) => {
    if (!live) return;
    root.textContent = "";
    if (!user) {
      root.textContent = options.userId;
      return;
    }
    if (user.avatarUrl) {
      const image = element("img");
      image.src = user.avatarUrl;
      image.alt = "";
      image.width = 20;
      image.height = 20;
      appendChildren(root, image, document.createTextNode(" "));
    }
    if (user.url) {
      const link = element("a");
      link.href = user.url;
      link.textContent = user.displayName;
      appendChildren(root, link);
    } else {
      appendChildren(root, document.createTextNode(user.displayName));
    }
  });
  return root;
}

export function createPieceInput(options: {
  catalog: CatalogClient;
  value?: string;
  onChange?: (pieceId: string) => void;
  placeholder?: string;
  searchLimit?: number;
}): DomInputControl {
  const root = element("div", "rl-piece-input");
  const selected = element("div", "rl-piece-input__selected");
  const search = element("input");
  search.type = "search";
  search.placeholder = options.placeholder ?? "Search pieces";
  const results = element("ul", "rl-piece-input__results");
  let value = options.value ?? "";
  let live = true;

  function renderSelected() {
    selected.textContent = "";
    if (!value) return;
    appendChildren(selected, 
      document.createTextNode("Selected: "),
      createPieceDisplay({ catalog: options.catalog, pieceId: value }),
      document.createTextNode(" "),
    );
    const clear = element("button");
    clear.type = "button";
    clear.textContent = "Clear";
    clear.addEventListener("click", () => setValue(""));
    appendChildren(selected, clear);
  }

  function setValue(next: string) {
    value = next;
    renderSelected();
    options.onChange?.(next);
    search.value = "";
    results.textContent = "";
  }

  search.addEventListener("input", () => {
    const query = search.value;
    options.catalog.searchPieces(query, options.searchLimit ?? 8).then((pieces) => {
      if (!live) return;
      results.textContent = "";
      for (const piece of pieces) {
        const item = element("li");
        const button = element("button");
        button.type = "button";
        appendChildren(button, createPieceDisplay({ catalog: options.catalog, pieceId: piece.id }));
        button.addEventListener("click", () => setValue(piece.id));
        appendChildren(item, button);
        appendChildren(results, item);
      }
    });
  });

  appendChildren(root, selected, search, results);
  renderSelected();

  return {
    element: root,
    getValue: () => value,
    setValue,
    destroy: () => {
      live = false;
      root.remove();
    },
  };
}

export function createUserInput(options: {
  catalog: CatalogClient;
  value?: string;
  onChange?: (userId: string) => void;
  placeholder?: string;
  searchLimit?: number;
}): DomInputControl {
  const root = element("div", "rl-user-input");
  const selected = element("div", "rl-user-input__selected");
  const search = element("input");
  search.type = "search";
  search.placeholder = options.placeholder ?? "Search users";
  const results = element("ul", "rl-user-input__results");
  let value = options.value ?? "";
  let live = true;

  function renderSelected() {
    selected.textContent = "";
    if (!value) return;
    appendChildren(selected, 
      document.createTextNode("Selected: "),
      createUserDisplay({ catalog: options.catalog, userId: value }),
      document.createTextNode(" "),
    );
    const clear = element("button");
    clear.type = "button";
    clear.textContent = "Clear";
    clear.addEventListener("click", () => setValue(""));
    appendChildren(selected, clear);
  }

  function setValue(next: string) {
    value = next;
    renderSelected();
    options.onChange?.(next);
    search.value = "";
    results.textContent = "";
  }

  search.addEventListener("input", () => {
    const query = search.value;
    options.catalog.searchUsers(query, options.searchLimit ?? 8).then((users) => {
      if (!live) return;
      results.textContent = "";
      for (const user of users) {
        const item = element("li");
        const button = element("button");
        button.type = "button";
        appendChildren(button, createUserDisplay({ catalog: options.catalog, userId: user.id }));
        button.addEventListener("click", () => setValue(user.id));
        appendChildren(item, button);
        appendChildren(results, item);
      }
    });
  });

  appendChildren(root, selected, search, results);
  renderSelected();

  return {
    element: root,
    getValue: () => value,
    setValue,
    destroy: () => {
      live = false;
      root.remove();
    },
  };
}

export type { Piece, UserSummary };
