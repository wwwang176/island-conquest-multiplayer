# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Island Conquest** — a multiplayer 3D FPS flag-capture game. A Node.js server runs the authoritative game simulation (AI soldiers, physics, flag capture) and streams snapshots to browser clients over WebSocket. Players join via the browser, pick a team and weapon, and fight alongside AI squads over 5 flag points on a procedurally generated tropical island.

## Development

Uses native ES modules. The server requires Node.js with dependencies managed via npm (`ws`, `three`, `cannon-es`, `three-mesh-bvh`). The client is bundled with Vite (`npm run build` produces `dist/`).

**Run locally:**
```
npm install
npm run build
npm start
```
Then open `http://localhost:8080`.

## Architecture

**Server entry:** `server.js` → creates `ServerGame` + `NetworkManager`.
**Client entry:** `src/client-main.js` → creates `ClientGame` instance.
**Client page:** `index.html` — served by the Node.js HTTP server.

### Module Layout

- **`core/`** — `EventBus.js` (pub/sub), `InputManager.js` (keyboard/mouse + pointer lock)
- **`client/`** — `ClientGame.js` (client-side orchestrator: renderer, scene, camera, HUD, input), `NetworkClient.js` (WebSocket connection + message handling), `EntityRenderer.js` (interpolated rendering of remote entities), `Interpolation.js` (snapshot interpolation), `VehicleRenderer.js` (vehicle rendering)
- **`server/`** — `ServerGame.js` (authoritative game loop + simulation), `NetworkManager.js` (HTTP server + WebSocket broadcast), `ServerAIManager.js` (server-side AI), `ServerSoldier.js` / `ServerPlayer.js` (server-side entities), `ServerPhysics.js`, `ServerIsland.js`, `ServerHelicopter.js`, `ServerVehicleManager.js`, `ServerGrenadeManager.js`
- **`shared/`** — `constants.js` (tick rate, port, game settings), `protocol.js` (message types), `DamageModel.js` / `DamageFalloff.js` (shared damage calculation), `CapsuleBody.js`
- **`entities/`** — `Soldier.js` (base entity: mesh, physics body, HP/regen/death), `Player.js` (extends Soldier with FPS camera + input), `Weapon.js` (hitscan rifle: ammo, recoil, reload, raycasting)
- **`world/`** — `Island.js` (procedural terrain + vegetation + cover generation), `CoverSystem.js` (cover point registry), `FlagPoint.js` (capture mechanics), `Noise.js` (simplex-like noise)
- **`ai/`** — `AIManager.js` (creates & updates all COMs per team), `AIController.js` (per-soldier behavior tree + movement + aiming + shooting), `BehaviorTree.js` (lightweight BT engine: Selector/Sequence/Condition/Action), `Personality.js` (6 personality types with tuning weights), `SquadCoordinator.js` (squad-level tactics), `TeamIntel.js` (shared enemy sighting board), `ThreatMap.js` (spatial threat heatmap), `NavGrid.js` (grid-based pathfinding with A*), `TacticalActions.js` (flanking, pre-aim, suppression helpers)
- **`systems/`** — `PhysicsWorld.js` (cannon-es wrapper), `ScoreManager.js` (flag-based scoring to 500), `SpawnSystem.js` (respawn point selection)
- **`vfx/`** — `TracerSystem.js` (bullet tracer lines), `ImpactVFX.js` (hit particles)
- **`ui/`** — `Minimap.js` (canvas-based minimap), `KillFeed.js` (kill notifications), `HUDController.js` (DOM overlay elements), `SpectatorHUD.js`
- **`workers/`** — `navgrid-worker.js` (off-thread NavGrid construction)

### Key Patterns

- **Client-server architecture**: Server runs the authoritative simulation at a fixed tick rate; clients interpolate between received snapshots for smooth rendering.
- **EventBus** for decoupled communication (`kill`, `gameOver`, `playerDied`, `playerHit`, `aiFired`). Systems subscribe in constructors.
- **Staggered AI updates**: AI soldiers update in round-robin batches across frames to stay within per-frame budget (not all 30 each frame).
- **NavGrid built in Web Worker** at startup (`Island.buildNavGridAsync()` → `navgrid-worker.js`), then handed to `AIManager`.
- **Hitscan shooting**: both player and AI use `THREE.Raycaster` against `island.collidables` + soldier meshes. No projectile simulation.
- **Soldier is the shared base** for both Player and AI COMs. Player adds FPS camera control; AI adds AIController with behavior tree.

## Known API Pitfalls (cannon-es)

- `Quaternion` has no `setFromEulerAngles()` — use `setFromAxisAngle(axis, angle)`.
- `Heightfield` height runs along local Z axis — requires rotation to align with Three.js Y-up world.

## Weapon System Notes

- Recoil recovery must check `triggerHeld` (whether fire key is held), not single-frame `isFiring`. Otherwise cooldown frames between shots trigger recovery and cancel accumulated recoil offset.

## Debug Visualizations

In-game key toggles (work in both spectator and playing modes):
- **T** — Threat map overlay (off → Team A → Team B)
- **B** — NavGrid blocked cells
