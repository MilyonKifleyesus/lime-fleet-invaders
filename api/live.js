// Vercel Function for Fleet Invaders Live: /api/live
// WebSocket connections from the big screen, phones and the host panel.
// See server/live.js.
import { createLiveServer } from '../server/live.js';

export default createLiveServer();
