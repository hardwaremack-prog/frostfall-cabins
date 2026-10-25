# Frostfall Cabins

A LAN multiplayer spin-off of Fernlight Frostfall. Five log cabins sit in different corners of one mountain valley — **Summit Lookout**, **Frozen Lake**, **Birch Glade**, **Old Mill** and **Hollow End**. Everyone on your Wi-Fi joins the same night, splits up between the cabins, hauls firewood, and tries to keep every stove burning through the **2:00 AM icy gale** until dawn.

![screenshot](screenshot.png)

## Start a game

One computer runs the server (a Raspberry Pi is plenty). Nothing to install — it only needs Python 3.

- **Raspberry Pi / Linux / Mac:** double-click `start-pi.sh` (or run `./start-pi.sh` in a terminal)
- **Windows:** double-click `start-windows.bat` (Python 3 must be installed)

The window prints an address like `http://192.168.1.42:8790`. Everyone opens that address in Chrome/Chromium on their own computer or Pi and picks a name and coat colour. The server computer can play too at `http://localhost:8790`.

Options: `python3 server.py --minutes 20` for a longer night (default 12), `--day 3` to start on day 3, `--port 9000` to change the port.

## The story (4 days)

| Day | What happens |
|---|---|
| **1** | Spread out across the five cabins. Haul firewood, light the stoves, heat cans of stew, survive the **2:00 AM icy gale**. |
| **2** | **Animals** roam the valley. An **axe** is stuck in the chopping block outside every cabin. Chase down deer and rabbits (they tire out), then cook the meat on a lit stove. |
| **3** | **Fishing.** Rods are on the Frozen Lake dock (and at Old Mill and Hollow End). Fish through the ice holes, cook the catch. |
| **4** | A broken **helicopter** sits on the pad between the Summit and Birch Glade. Race to bring its **battery** (Summit Lookout), **fuel can** (Old Mill) and **rotor blade** (Hollow End) and start it. At **10:30 PM the air-raid sirens** sound — get to the **solar radio** on a cabin wall to hear where the valley's **only bunker** is. The ICBM hits at 12:40 AM. Everyone in the bunker survives; a running helicopter can fly everyone nearby straight there. |

After day 4 the story starts again from day 1.

## Controls

| Key | Does |
|---|---|
| WASD / arrows | walk · **Shift** run · **Space** jump |
| Mouse | look (click the game to grab the mouse, Esc to free it) |
| **E** or **click** | pick up / use — doors, logs, woodbox, stove, cans, candles, radio, axe, rods, ice holes, helicopter, bunker hatch. With an axe, click to swing. |
| **T** | chat · **Tab** who's where · **M** big map |

Tips: things you can pick up glow. Warmth drains outdoors (much faster in the gale); a lit stove warms you, candles help a little. Freeze solid and you thaw out 10 seconds later by the strongest fire.

**Host commands** (type in chat): `/day 1`–`/day 4` jump to a day, `/skip` next day, `/time 22:00` set the clock.

## Files

- `server.py` — game server and web server in one file (Python standard library only)
- `public/` — the game itself (three.js is bundled, so it works with no internet)
