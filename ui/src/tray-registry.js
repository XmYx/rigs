// The menu bar tray's item registry (no DOM): modules plug in with registerTrayItem({ id, order, render, popover }).
//   id       unique; registering the same id again replaces the item
//   order    left-to-right position (lower first, ties by id)
//   render   (ctx) => HTMLElement — the tray button; ctx = { phone, refresh(), openPopover() }
//   popover  optional (ctx) => HTMLElement — what opens when the item is clicked (the tray wires the click)
//   phone    true to keep the item in the compact phone tray

export function createTrayRegistry() {
  const map = new Map();
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn());
  return {
    register(item) {
      if (!item?.id || typeof item.render !== 'function') throw new Error('a tray item needs an id and render()');
      map.set(item.id, { order: 100, ...item });
      emit();
      return () => { if (map.get(item.id) === item) { map.delete(item.id); emit(); } };
    },
    unregister(id) { if (map.delete(id)) emit(); },
    items({ phone = false } = {}) {
      return [...map.values()].filter((i) => !phone || i.phone).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
