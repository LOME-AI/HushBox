import { create } from 'zustand';

interface WebsocketInboundActivityState {
  pendingInbound: number;
  startProcessing: () => void;
  endProcessing: () => void;
}

export const useWebsocketInboundActivityStore = create<WebsocketInboundActivityState>()((set) => ({
  pendingInbound: 0,

  startProcessing: () => {
    set((state) => ({ pendingInbound: state.pendingInbound + 1 }));
  },

  endProcessing: () => {
    set((state) => ({ pendingInbound: Math.max(0, state.pendingInbound - 1) }));
  },
}));
