#!/usr/bin/env python3
"""
Frostfall Cabins - LAN multiplayer server
-----------------------------------------
Zero dependencies: just Python 3.8+ (already on every Raspberry Pi).

    python3 server.py                 # default 12-minute night, port 8790
    python3 server.py --minutes 20    # longer night
    python3 server.py --port 9000

Everyone on the same Wi-Fi opens  http://<this-computer's-IP>:8790  in a browser.
"""
import argparse
import asyncio
import base64
import hashlib
import json
import math
import mimetypes
import os
import random
import socket
import struct
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(HERE, "public")
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

# ----------------------------------------------------------------- world ---
# Game clock is in "game minutes" after 18:00. 720 = 06:00 dawn.
GALE_START = 480   # 02:00
GALE_END = 690     # 05:30
DAWN = 720
STORY_DAYS = 4
SIREN_AT = 270     # day 4: 10:30 PM air-raid sirens
IMPACT_AT = 400    # day 4: 12:40 AM missile impact
FINALE_END = 430   # day 4 ends shortly after impact

CABIN_W, CABIN_D = 10.0, 8.0          # interior footprint (local x, local z)
STOVE = (-3.2, -2.7)
WOODBOX = (-4.0, 0.6)
PANTRY = (3.9, -2.9)
RADIO = (4.75, -0.9)                  # solar radio on the right-hand wall
CANDLES = [(1.5, 0.55), (2.5, 0.55), (4.62, 1.6)]
WOODBOX_MAX = 12
CARRY_MAX = 4
FOOD_MAX = 6
FUEL_PER_LOG = 18.0
REACH = 4.2

CABIN_SPECS = [
    # name, x, z, region
    ("Summit Lookout", 0.0, -205.0, "summit"),
    ("Frozen Lake",   -168.0, -52.0, "lake"),
    ("Birch Glade",    178.0, -78.0, "birch"),
    ("Old Mill",      -118.0, 168.0, "mill"),
    ("Hollow End",     146.0, 158.0, "hollow"),
]
LAKE = (-222.0, -8.0, 40.0)
HELIPAD = (88.0, -128.0)
BUNKERS = [
    (-72.0, -118.0, "in the rocks beneath the ridge, between the Summit Lookout and the Frozen Lake"),
    (226.0, 28.0, "past Birch Glade, at the edge of the eastern woods"),
    (-32.0, 236.0, "south of the Old Mill, against the valley wall"),
]
HELI_PARTS = [("battery", 0, "battery"), ("fuel", 3, "fuel can"), ("rotor", 4, "rotor blade")]
FOOD = {"stew": (20, 55, 12, "hot stew"), "meat": (25, 70, 16, "roast venison"),
        "fish": (15, 45, 10, "pan-fried trout")}
DAY_INTRO = {
    1: "Day 1 - Keep the stoves lit. The icy gale hits at 2:00 AM.",
    2: "Day 2 - Animals are out! Grab an axe from a cabin's chopping block, hunt, and cook the meat on a stove.",
    3: "Day 3 - Fishing! Rods are on the Frozen Lake dock, Old Mill and Hollow End. Fish through the ice holes.",
    4: "Day 4 - A broken helicopter sits on the pad between the Summit and Birch Glade. Find its battery, fuel and rotor blade - fast.",
}


def cabin_rot(x, z):
    # local +z (the door) faces the middle of the map
    return math.atan2(-x, -z)


def to_world(cab, lx, lz):
    c, s = math.cos(cab["rot"]), math.sin(cab["rot"])
    return cab["x"] + lx * c + lz * s, cab["z"] - lx * s + lz * c


def to_local(cab, wx, wz):
    dx, dz = wx - cab["x"], wz - cab["z"]
    c, s = math.cos(cab["rot"]), math.sin(cab["rot"])
    return dx * c - dz * s, dx * s + dz * c


def dist2(ax, az, bx, bz):
    return (ax - bx) ** 2 + (az - bz) ** 2


def spec_cabin(i):
    name, x, z, region = CABIN_SPECS[i]
    return {"x": x, "z": z, "rot": cabin_rot(x, z)}


def dock_spot(along, side=0.0):
    """A point on the Frozen Lake dock: `along` metres from the land end, `side` across."""
    lx, lz, lr = LAKE
    cx, cz = CABIN_SPECS[1][1], CABIN_SPECS[1][2]
    d = math.hypot(cx - lx, cz - lz)
    ux, uz = (cx - lx) / d, (cz - lz) / d
    sx, sz = lx + ux * (lr - 2), lz + uz * (lr - 2)      # dock centre (matches the client)
    ex, ez = sx + ux * 6, sz + uz * 6                      # land end
    return ex - ux * along + (-uz) * side, ez - uz * along + ux * side


def ice_holes():
    lx, lz, _ = LAKE
    out = []
    for k in range(6):
        a = k / 6 * math.tau + 0.4
        r = 13 if k % 2 else 25
        out.append((round(lx + math.cos(a) * r, 2), round(lz + math.sin(a) * r, 2)))
    return out


ICE_HOLES = ice_holes()


class Game:
    def __init__(self, night_seconds, start_day=1):
        self.night_seconds = night_seconds
        self.seed = random.randint(1, 999999)
        self.players = {}          # id -> dict
        self.clients = {}          # id -> Client
        self.next_id = 1
        self.events = []
        self.round_no = 0
        self.day = max(1, min(STORY_DAYS, start_day)) - 1
        self.bunker = random.randrange(len(BUNKERS))
        self.new_round()

    # -- setup ---------------------------------------------------------------
    def new_round(self, restart=False):
        self.round_no += 1
        if restart or self.day >= STORY_DAYS:
            self.day = 1
            self.bunker = random.randrange(len(BUNKERS))
            for p in self.players.values():
                self.reset_tools(p)
        else:
            self.day += 1
        self.minutes = 0.0
        self.phase = "night"       # night | dawn
        self.dawn_timer = 0.0
        self.summary = None
        self.siren = False
        self.impact = False
        self.cabins = []
        for i, (name, x, z, region) in enumerate(CABIN_SPECS):
            self.cabins.append({
                "i": i, "name": name, "x": x, "z": z, "region": region,
                "rot": cabin_rot(x, z),
                "fuel": 0.0, "wood": 2, "candles": [0.0, 0.0, 0.0],
                "cans": 3, "pot": -1.0, "potKind": "",
            })
        rng = random.Random(self.seed + self.round_no)
        self.rng = rng
        self.logs = {}
        self.log_id = 1
        for cab in self.cabins:                       # the pile by every door
            for lx, lz in ((-2.0, 5.7), (-2.7, 6.1), (-1.4, 6.3)):
                x, z = to_world(cab, lx, lz)
                self.add_log(x, z, rng.random() * math.pi)
        for _ in range(70):
            self.spawn_log(rng)
        self.respawn_acc = 0.0
        self.place_items()
        self.animals = {}
        self.animal_id = 1
        self.animal_acc = 0.0
        if self.day >= 2:
            for _ in range(12):
                self.spawn_animal("deer")
            for _ in range(14):
                self.spawn_animal("rabbit")
        self.heli = {"parts": [False, False, False], "running": False,
                     "x": HELIPAD[0], "z": HELIPAD[1], "fly": 0.0, "flyFrom": None}
        for p in self.players.values():
            self.reset_player(p, spawn=True)
        self.emit(DAY_INTRO[self.day])

    def add_log(self, x, z, r):
        self.logs[self.log_id] = {"id": self.log_id, "x": round(x, 2), "z": round(z, 2), "r": round(r, 2)}
        self.log_id += 1

    def spawn_log(self, rng):
        for _ in range(30):
            # cluster logs around cabins and along the routes between them
            if rng.random() < 0.6:
                c = rng.choice(CABIN_SPECS)
                a = rng.random() * math.tau
                r = 14 + rng.random() * 50
                x, z = c[1] + math.cos(a) * r, c[2] + math.sin(a) * r
            else:
                a = rng.random() * math.tau
                r = 20 + rng.random() * 220
                x, z = math.cos(a) * r, math.sin(a) * r
            if x * x + z * z > 280 ** 2:
                continue
            if any(dist2(x, z, c[1], c[2]) < 12 ** 2 for c in CABIN_SPECS):
                continue
            if dist2(x, z, LAKE[0], LAKE[1]) < (LAKE[2] + 4) ** 2:   # not on the frozen lake
                continue
            if dist2(x, z, HELIPAD[0], HELIPAD[1]) < 12 ** 2:
                continue
            self.add_log(x, z, rng.random() * math.pi)
            return

    def place_items(self):
        """Tools and parts for today. Anything a player is already carrying stays with them."""
        held = set()
        for p in self.players.values():
            if p.get("axe"):
                held.add(p["axe"])
            if p.get("rod"):
                held.add(p["rod"])
        self.items = {}
        defs = []
        if self.day >= 2:
            for i in range(5):
                defs.append(("axe%d" % i, "axe", to_world(spec_cabin(i), 3.6, 6.3)))
        if self.day >= 3:
            for k, side in enumerate((-0.9, 0.0, 0.9)):
                defs.append(("rod%d" % k, "rod", dock_spot(1.2, side)))
            defs.append(("rod3", "rod", to_world(spec_cabin(3), 4.6, 6.0)))
            defs.append(("rod4", "rod", to_world(spec_cabin(4), 4.6, 6.0)))
        if self.day >= 4:
            for kind, ci, _ in HELI_PARTS:
                defs.append((kind, kind, to_world(spec_cabin(ci), -4.3, 7.4)))
        for iid, kind, (x, z) in defs:
            if iid not in held:
                self.items[iid] = {"id": iid, "kind": kind, "x": round(x, 2), "z": round(z, 2)}

    def spawn_animal(self, kind):
        rng = self.rng
        for _ in range(40):
            a = rng.random() * math.tau
            r = 40 + rng.random() * 220
            x, z = math.cos(a) * r, math.sin(a) * r
            if any(dist2(x, z, c[1], c[2]) < 30 ** 2 for c in CABIN_SPECS):
                continue
            if any(dist2(x, z, p["x"], p["z"]) < 25 ** 2 for p in self.players.values()):
                continue
            self.animals[self.animal_id] = {
                "id": self.animal_id, "kind": kind, "x": x, "z": z, "ry": rng.random() * math.tau,
                "spd": 0.0, "hp": 2 if kind == "deer" else 1, "t": rng.random() * 4, "flee": False,
                "stam": 5.0, "stun": 0.0}
            self.animal_id += 1
            return

    def reset_tools(self, p):
        p["axe"] = None
        p["rod"] = None
        p["meat"] = 0
        p["fish"] = 0

    def reset_player(self, p, spawn=False):
        p["warmth"] = 100.0
        p["hunger"] = 85.0
        p["carry"] = 0
        p["can"] = 0          # 0 none, 1 cold can in hand
        p["frozen"] = 0.0
        p["inside"] = -1
        p["part"] = None
        p["fishT"] = 0.0
        p["fishHole"] = -1
        p["kb"] = False       # heard where the bunker is
        p["inB"] = False      # inside the bunker
        p["lost"] = False     # caught outside at impact
        p["fly"] = 0.0
        p["hitCd"] = 0.0
        if spawn:
            a = random.random() * math.tau
            p["x"], p["z"] = math.cos(a) * 4, 30 + math.sin(a) * 4
            p["teleport"] = True

    # -- helpers -------------------------------------------------------------
    def emit(self, text):
        self.events.append(text)

    def tell(self, p, msg):
        c = self.clients.get(p["id"])
        if c:
            c.send_text(json.dumps(msg))

    def gale_strength(self):
        if self.day >= STORY_DAYS:
            return 0.0
        m = self.minutes
        if m < GALE_START - 20 or m >= GALE_END + 15:
            return 0.0
        if m < GALE_START:
            return (m - (GALE_START - 20)) / 20 * 0.35
        if m < GALE_START + 15:
            return 0.35 + (m - GALE_START) / 15 * 0.65
        if m < GALE_END:
            return 1.0
        return max(0.0, 1.0 - (m - GALE_END) / 15)

    def inside_cabin(self, x, z):
        for cab in self.cabins:
            lx, lz = to_local(cab, x, z)
            if abs(lx) < CABIN_W / 2 and abs(lz) < CABIN_D / 2:
                return cab["i"]
        return -1

    def near(self, p, cab, spot):
        wx, wz = to_world(cab, *spot)
        return dist2(p["x"], p["z"], wx, wz) <= REACH ** 2

    def bunker_pos(self):
        return BUNKERS[self.bunker]

    # -- input ---------------------------------------------------------------
    def add_player(self, client, name, color):
        pid = self.next_id
        self.next_id += 1
        name = (name or "Hiker").strip()[:16] or "Hiker"
        color = color if isinstance(color, str) and len(color) <= 9 else "#e8a33d"
        p = {"id": pid, "name": name, "color": color, "x": 0.0, "y": 0.0, "z": 30.0,
             "ry": 0.0, "freezes": 0, "logsIn": 0, "kills": 0, "catches": 0}
        self.reset_tools(p)
        self.reset_player(p, spawn=True)
        self.players[pid] = p
        self.clients[pid] = client
        self.emit("%s arrived at the trailhead." % name)
        return pid

    def remove_player(self, pid):
        p = self.players.pop(pid, None)
        self.clients.pop(pid, None)
        if p:
            self.emit("%s headed home." % p["name"])
            # put their tools back where they came from
            self.place_items()

    def on_pos(self, p, m):
        if p["frozen"] > 0 or p["lost"] or p["fly"] > 0:
            return
        try:
            x, y, z, ry = float(m["x"]), float(m["y"]), float(m["z"]), float(m["ry"])
        except (KeyError, TypeError, ValueError):
            return
        if not all(map(math.isfinite, (x, y, z, ry))):
            return
        if p["inB"]:
            bx, bz, _ = self.bunker_pos()     # stay inside the shelter
            x, z = max(bx - 4, min(bx + 4, x)), max(bz - 3, min(bz + 3, z))
        p["x"], p["y"], p["z"], p["ry"] = x, y, z, ry

    def on_act(self, p, m):
        if p["frozen"] > 0 or p["lost"] or p["fly"] > 0 or self.phase != "night":
            return
        try:                                   # the action carries where the player is right now
            ax, az = float(m["x"]), float(m["z"])
            if math.isfinite(ax) and math.isfinite(az) and abs(ax) < 400 and abs(az) < 400 and not p["inB"]:
                p["x"], p["z"] = ax, az
        except (KeyError, TypeError, ValueError):
            pass
        a = m.get("a")
        if a == "pickup":
            log = self.logs.get(m.get("id"))
            if log and p["carry"] < CARRY_MAX and dist2(p["x"], p["z"], log["x"], log["z"]) < 5.5 ** 2:
                del self.logs[log["id"]]
                p["carry"] += 1
            return
        if a == "item":
            it = self.items.get(m.get("id"))
            if not it or dist2(p["x"], p["z"], it["x"], it["z"]) > 5 ** 2:
                return
            k = it["kind"]
            if k == "axe" and not p["axe"]:
                p["axe"] = it["id"]
                self.emit("%s found an axe." % p["name"])
            elif k == "rod" and not p["rod"]:
                p["rod"] = it["id"]
                self.emit("%s found a fishing rod." % p["name"])
            elif k in ("battery", "fuel", "rotor") and not p["part"]:
                p["part"] = k
                self.emit("%s grabbed the helicopter %s!" % (p["name"], dict((h[0], h[2]) for h in HELI_PARTS)[k]))
            else:
                return
            del self.items[it["id"]]
            return
        if a == "hit":
            an = self.animals.get(m.get("id"))
            if not an or not p["axe"] or p["hitCd"] > 0:
                return
            if dist2(p["x"], p["z"], an["x"], an["z"]) > 5.2 ** 2:
                return
            p["hitCd"] = 0.45
            an["hp"] -= 1
            an["stun"] = 1.6                   # a hit makes it stumble for a moment
            if an["hp"] <= 0:
                del self.animals[an["id"]]
                got = 2 if an["kind"] == "deer" else 1
                p["meat"] = min(FOOD_MAX, p["meat"] + got)
                p["kills"] += 1
                self.emit("%s hunted a %s (+%d meat)." % (p["name"], an["kind"], got))
            return
        if a == "fish":
            try:
                i = int(m.get("i"))
                hx, hz = ICE_HOLES[i]
            except (TypeError, ValueError, IndexError):
                return
            if not p["rod"] or dist2(p["x"], p["z"], hx, hz) > 3.2 ** 2:
                return
            if p["fishHole"] == i and p["fishT"] > 0:
                p["fishT"], p["fishHole"] = 0.0, -1      # reel in early
            elif p["fish"] < FOOD_MAX:
                p["fishHole"] = i
                p["fishT"] = 4.0 + self.rng.random() * 6.0
            return
        if a == "heli":
            h = self.heli
            if self.day < 4 or dist2(p["x"], p["z"], h["x"], h["z"]) > 7 ** 2 or h["fly"] > 0:
                return
            if p["part"]:
                idx = [x[0] for x in HELI_PARTS].index(p["part"])
                h["parts"][idx] = True
                self.emit("%s fitted the %s to the helicopter (%d/3)." %
                          (p["name"], HELI_PARTS[idx][2], sum(h["parts"])))
                p["part"] = None
            elif all(h["parts"]) and not h["running"]:
                h["running"] = True
                self.emit("%s got the helicopter running! The rotors are turning." % p["name"])
            elif h["running"] and self.siren and not self.impact:
                bx, bz, _ = self.bunker_pos()
                h["fly"] = 8.0
                h["flyFrom"] = (h["x"], h["z"])
                riders = [q for q in self.players.values()
                          if not q["lost"] and not q["inB"] and q["frozen"] <= 0
                          and dist2(q["x"], q["z"], h["x"], h["z"]) < 9 ** 2]
                for q in riders:
                    q["fly"] = 8.0
                    q["kb"] = True
                self.emit("%s is flying %d to the bunker!" % (p["name"], len(riders)))
            return
        if a == "bunker":
            bx, bz, _ = self.bunker_pos()
            if dist2(p["x"], p["z"], bx, bz) > 4.5 ** 2:
                return
            if p["inB"]:
                if self.siren and not self.impact:
                    return                                 # don't go back out now!
                p["inB"] = False
                p["x"], p["z"] = bx, bz + 3.5
                p["teleport"] = True
            elif self.day >= 4:
                p["inB"] = True
                p["kb"] = True
                p["x"], p["z"] = bx, bz
                p["teleport"] = True
                self.emit("%s made it into the bunker!" % p["name"])
            return
        try:
            cab = self.cabins[int(m.get("cabin"))]
        except (TypeError, ValueError, IndexError):
            return
        if a == "woodbox" and self.near(p, cab, WOODBOX):
            if p["carry"] > 0:
                n = min(p["carry"], WOODBOX_MAX - cab["wood"])
                cab["wood"] += n
                p["carry"] -= n
                p["logsIn"] += n
            elif cab["wood"] > 0:
                cab["wood"] -= 1
                p["carry"] += 1
        elif a == "radio" and self.near(p, cab, RADIO):
            self.tell(p, {"t": "radio", "text": self.radio_text(p)})
        elif a == "stove" and self.near(p, cab, STOVE):
            kind = cab["potKind"]
            if cab["pot"] >= 0 and kind and cab["pot"] >= FOOD[kind][0]:   # food is ready -> eat it
                _, food, warm, label = FOOD[kind]
                cab["pot"], cab["potKind"] = -1.0, ""
                p["hunger"] = min(100.0, p["hunger"] + food)
                p["warmth"] = min(100.0, p["warmth"] + warm)
                self.emit("%s ate %s at %s." % (p["name"], label, cab["name"]))
            elif cab["pot"] < 0 and cab["fuel"] > 0 and (p["meat"] or p["fish"] or p["can"]):
                if p["meat"]:
                    p["meat"] -= 1
                    cab["potKind"] = "meat"
                elif p["fish"]:
                    p["fish"] -= 1
                    cab["potKind"] = "fish"
                else:
                    p["can"] = 0
                    cab["potKind"] = "stew"
                cab["pot"] = 0.0
            elif cab["pot"] < 0 and p["can"]:            # stove is cold, but you can still set the can on
                p["can"] = 0
                cab["potKind"] = "stew"
                cab["pot"] = 0.0
            elif p["carry"] > 0 or cab["wood"] > 0:      # feed the fire
                if cab["fuel"] > 100 - FUEL_PER_LOG * 0.5:
                    return
                if p["carry"] > 0:
                    p["carry"] -= 1
                else:
                    cab["wood"] -= 1
                was_out = cab["fuel"] <= 0
                cab["fuel"] = min(100.0, cab["fuel"] + FUEL_PER_LOG)
                p["logsIn"] += 1
                if was_out:
                    self.emit("%s lit the stove at %s." % (p["name"], cab["name"]))
        elif a == "pantry" and self.near(p, cab, PANTRY):
            if not p["can"] and cab["cans"] > 0:
                cab["cans"] -= 1
                p["can"] = 1
        elif a == "candle":
            try:
                i = int(m.get("i"))
                spot = CANDLES[i]
            except (TypeError, ValueError, IndexError):
                return
            if self.near(p, cab, spot):
                if cab["candles"][i] > 0:
                    cab["candles"][i] = 0.0
                elif cab["fuel"] > 0:   # need a flame from the stove
                    cab["candles"][i] = 240.0

    def radio_text(self, p):
        if self.day >= 4 and self.siren and not self.impact:
            p["kb"] = True
            bx, bz, where = self.bunker_pos()
            left = max(0, int((IMPACT_AT - self.minutes) * self.night_seconds / DAWN))
            return ("EMERGENCY ALERT SYSTEM. A Russian ICBM launch has been detected. Impact expected in "
                    "about %d:%02d. There is only ONE fallout shelter in the valley: a concrete bunker %s. "
                    "It is now marked on your map. Get inside and stay inside." % (left // 60, left % 60, where))
        if self.impact:
            return "...static... This is the Emergency Alert System. Remain in shelter. Do not go outside. ...static..."
        if self.day >= 4:
            return ("KVLY Mountain Radio... unusual military activity has been reported overseas. "
                    "Civil defence sirens are being tested across the region. Stay near a radio tonight.")
        if self.day == 3:
            return "KVLY Mountain Radio... the lake ice is thick enough for fishing. Trout are biting near the middle. Gale after 2 AM."
        if self.day == 2:
            return "KVLY Mountain Radio... deer and rabbits are moving through the valley tonight. Another icy gale after 2 AM."
        return "KVLY Mountain Radio... severe weather warning: an icy gale will sweep the valley after 2 AM. Keep your stove burning."

    def on_chat(self, p, m):
        text = str(m.get("text", "")).strip()[:120]
        if not text:
            return
        if text.startswith("/"):
            self.command(p, text)
            return
        self.broadcast({"t": "chat", "from": p["name"], "color": p["color"], "text": text})

    def command(self, p, text):
        parts = text.split()
        cmd = parts[0].lower()
        if cmd == "/day" and len(parts) > 1 and parts[1].isdigit():
            n = max(1, min(STORY_DAYS, int(parts[1])))
            self.day = n - 1
            if n == 1:
                self.day = STORY_DAYS
            self.emit("%s skipped to day %d." % (p["name"], n))
            self.new_round()
        elif cmd == "/skip":
            self.emit("%s skipped to the next day." % p["name"])
            self.new_round()
        elif cmd == "/time" and len(parts) > 1 and ":" in parts[1]:
            try:
                h, mm = [int(v) for v in parts[1].split(":")]
            except ValueError:
                return
            t = ((h - 18) % 24) * 60 + mm
            if 0 <= t < DAWN:
                self.minutes = float(t)
                self.emit("%s set the clock to %s." % (p["name"], parts[1]))
        else:
            self.tell(p, {"t": "chat", "from": "Server", "color": "#9fb0c8",
                          "text": "Commands: /day 1-4, /skip, /time 22:00"})

    # -- simulation ----------------------------------------------------------
    def step(self, dt):
        if self.phase == "dawn":
            self.dawn_timer -= dt
            if self.dawn_timer <= 0:
                self.new_round()
            return
        gm = dt * DAWN / self.night_seconds     # game minutes this tick
        self.minutes += gm
        gale = self.gale_strength()

        for cab in self.cabins:
            if cab["fuel"] > 0:
                cab["fuel"] = max(0.0, cab["fuel"] - gm * (0.12 + 0.16 * gale))
                if cab["fuel"] == 0:
                    self.emit("The stove at %s went out!" % cab["name"])
            for i in range(3):
                if cab["candles"][i] > 0:
                    cab["candles"][i] = max(0.0, cab["candles"][i] - gm * (1 + gale))
            if cab["pot"] >= 0 and cab["potKind"] and cab["fuel"] > 0:
                cab["pot"] = min(float(FOOD[cab["potKind"]][0]), cab["pot"] + gm)

        # logs trickle back in, but not during the gale
        if gale < 0.5:
            self.respawn_acc += gm
            while self.respawn_acc > 6:
                self.respawn_acc -= 6
                if len(self.logs) < 85:
                    self.spawn_log(self.rng)

        self.step_animals(dt, gm)
        self.step_story(dt)

        late = 1.0 if self.minutes > 360 else self.minutes / 360
        for p in self.players.values():
            p["hitCd"] = max(0.0, p["hitCd"] - dt)
            if p["lost"]:
                continue
            if p["fly"] > 0:
                continue
            if p["frozen"] > 0:
                p["frozen"] -= dt
                if p["frozen"] <= 0:
                    self.thaw(p)
                continue
            if p["fishT"] > 0:
                hx, hz = ICE_HOLES[p["fishHole"]]
                if dist2(p["x"], p["z"], hx, hz) > 3.5 ** 2:
                    p["fishT"], p["fishHole"] = 0.0, -1
                else:
                    p["fishT"] -= dt
                    if p["fishT"] <= 0:
                        p["fishT"], p["fishHole"] = 0.0, -1
                        p["fish"] = min(FOOD_MAX, p["fish"] + 1)
                        p["catches"] += 1
                        self.emit("%s caught a %s!" % (p["name"], self.rng.choice(
                            ["rainbow trout", "brook trout", "lake perch", "arctic char"])))
            ci = self.inside_cabin(p["x"], p["z"])
            p["inside"] = ci
            if p["inB"]:
                d = 0.25                              # the shelter is snug
            elif ci >= 0:
                cab = self.cabins[ci]
                if cab["fuel"] > 0:
                    lit = sum(1 for c in cab["candles"] if c > 0)
                    d = 0.55 + 0.12 * lit
                    if self.near(p, cab, STOVE):
                        d += 0.4
                else:
                    d = -(0.05 + 0.3 * gale)
            else:
                d = -(0.09 + 0.07 * late + 0.75 * gale)
            p["hunger"] = max(0.0, p["hunger"] - gm * 0.14)
            if p["hunger"] <= 0:
                d -= 0.15
            p["warmth"] = max(0.0, min(100.0, p["warmth"] + d * gm))
            if p["warmth"] <= 0:
                p["frozen"] = 10.0
                p["freezes"] += 1
                p["carry"] = 0
                p["can"] = 0
                p["fishT"], p["fishHole"] = 0.0, -1
                self.emit("%s froze solid!" % p["name"])

        if self.day >= STORY_DAYS and self.minutes >= FINALE_END:
            self.end_round()
        elif self.minutes >= DAWN:
            self.end_round()

    def step_animals(self, dt, gm):
        if self.day < 2:
            return
        rng = self.rng
        active = [p for p in self.players.values()
                  if not p["lost"] and not p["inB"] and p["inside"] < 0 and p["frozen"] <= 0]
        for an in list(self.animals.values()):
            deer = an["kind"] == "deer"
            scare = 10.0 if deer else 6.5
            near_p, nd = None, scare * scare
            for p in active:
                d = dist2(an["x"], an["z"], p["x"], p["z"])
                if d < nd:
                    near_p, nd = p, d
            an["t"] -= dt
            an["stun"] = max(0.0, an["stun"] - dt)
            if an["flee"]:
                an["stam"] = max(0.0, an["stam"] - dt)
            else:
                an["stam"] = min(5.0, an["stam"] + dt * 0.8)
            if an["stun"] > 0:
                an["spd"] = 1.2
            elif near_p and an["stam"] > 0:
                an["flee"] = True
                away = math.atan2(an["x"] - near_p["x"], an["z"] - near_p["z"])
                an["ry"] = away + (rng.random() - 0.5) * 0.5
                an["spd"] = 6.0 if deer else 5.0
                an["t"] = 2.5
            elif near_p:                                  # worn out: it can only trot
                an["flee"] = False
                an["spd"] = 2.2 if deer else 1.8
            elif an["t"] <= 0:
                an["flee"] = False
                an["t"] = 2 + rng.random() * 5
                if rng.random() < 0.45:
                    an["spd"] = 0.0
                else:
                    an["ry"] += (rng.random() - 0.5) * 2.2
                    an["spd"] = (1.3 if deer else 1.0) * (0.7 + rng.random() * 0.6)
            elif not an["flee"] and an["spd"] > 0:
                an["ry"] += (rng.random() - 0.5) * 0.2 * dt
            nx = an["x"] + math.sin(an["ry"]) * an["spd"] * dt
            nz = an["z"] + math.cos(an["ry"]) * an["spd"] * dt
            r = math.hypot(nx, nz)
            if r > 268:                                   # turn back from the valley walls
                an["ry"] = math.atan2(-nx, -nz)
                nx, nz = nx * 268 / r, nz * 268 / r
            for c in CABIN_SPECS:                         # walk around the cabins
                d = math.hypot(nx - c[1], nz - c[2])
                if d < 9:
                    nx, nz = c[1] + (nx - c[1]) / max(d, 0.01) * 9, c[2] + (nz - c[2]) / max(d, 0.01) * 9
            an["x"], an["z"] = nx, nz
        # new animals wander in now and then
        self.animal_acc += gm
        if self.animal_acc > 25:
            self.animal_acc = 0
            deer = sum(1 for a in self.animals.values() if a["kind"] == "deer")
            if deer < 12:
                self.spawn_animal("deer")
            if len(self.animals) - deer < 14:
                self.spawn_animal("rabbit")

    def step_story(self, dt):
        h = self.heli
        if h["fly"] > 0:
            h["fly"] = max(0.0, h["fly"] - dt)
            bx, bz, _ = self.bunker_pos()
            fx, fz = h["flyFrom"]
            t = 1 - h["fly"] / 8.0
            h["x"], h["z"] = fx + (bx + 9 - fx) * t, fz + (bz + 6 - fz) * t
            for q in self.players.values():
                if q["fly"] > 0:
                    q["fly"] = h["fly"]
                    q["x"], q["z"] = h["x"], h["z"]
                    if h["fly"] <= 0:
                        q["x"], q["z"] = bx + 1.2, bz + 2.4
                        q["teleport"] = True
            if h["fly"] <= 0:
                self.emit("The helicopter touched down beside the bunker. Get inside!")
        if self.day < STORY_DAYS:
            return
        if not self.siren and self.minutes >= SIREN_AT:
            self.siren = True
            self.emit("AIR RAID SIRENS! Get to a cabin's solar radio for instructions - NOW!")
        if self.siren and not self.impact and self.minutes >= IMPACT_AT:
            self.impact = True
            saved, lost = [], []
            for p in self.players.values():
                if p["inB"]:
                    saved.append(p["name"])
                else:
                    p["lost"] = True
                    p["fishT"], p["fishHole"] = 0.0, -1
                    lost.append(p["name"])
            self.emit("IMPACT. The shockwave rolls across the valley.")
            if saved:
                self.emit("Safe in the bunker: %s." % ", ".join(saved))
            if lost:
                self.emit("Didn't make it: %s." % ", ".join(lost))

    def thaw(self, p):
        # wake up in the warmest cabin, or the trailhead if every stove is out
        lit = [c for c in self.cabins if c["fuel"] > 0]
        p["warmth"], p["hunger"], p["frozen"] = 45.0, max(p["hunger"], 30.0), 0.0
        if lit:
            c = max(lit, key=lambda c: c["fuel"])
            p["x"], p["z"] = to_world(c, 0.0, 1.5)
            self.emit("%s thawed out by the fire at %s." % (p["name"], c["name"]))
        else:
            p["x"], p["z"] = 0.0, 30.0
            self.emit("%s thawed out at the trailhead." % p["name"])
        p["teleport"] = True

    def end_round(self):
        self.phase = "dawn"
        self.dawn_timer = 30.0 if self.day >= STORY_DAYS else 25.0
        lit = [c["name"] for c in self.cabins if c["fuel"] > 0]
        finale = self.day >= STORY_DAYS
        self.summary = {
            "round": self.round_no, "day": self.day, "finale": finale,
            "litCabins": lit,
            "saved": [p["name"] for p in self.players.values() if p["inB"]] if finale else None,
            "players": sorted(
                [{"name": p["name"], "color": p["color"], "freezes": p["freezes"],
                  "logs": p["logsIn"], "kills": p["kills"], "catches": p["catches"],
                  "saved": bool(p["inB"])} for p in self.players.values()],
                key=lambda r: (not r["saved"], r["freezes"], -r["logs"])),
        }
        if finale:
            n = len(self.summary["saved"])
            self.emit("The valley falls silent. %d of %d made it to the bunker." % (n, len(self.players)))
        else:
            self.emit("Dawn breaks on day %d. %d of 5 cabins still burning." % (self.day, len(lit)))
        for p in self.players.values():
            p["freezes"] = 0
            p["logsIn"] = 0
            p["kills"] = 0
            p["catches"] = 0

    # -- networking ----------------------------------------------------------
    def world_info(self):
        return {"seed": self.seed, "cabins": [
            {"i": c["i"], "name": c["name"], "x": c["x"], "z": c["z"], "rot": c["rot"],
             "region": c["region"]} for c in self.cabins],
            "galeStart": GALE_START, "galeEnd": GALE_END, "dawn": DAWN,
            "sirenAt": SIREN_AT, "impactAt": IMPACT_AT, "days": STORY_DAYS,
            "helipad": HELIPAD, "bunkers": [[b[0], b[1]] for b in BUNKERS],
            "holes": ICE_HOLES, "radio": RADIO,
            "nightSeconds": self.night_seconds}

    def snapshot(self):
        players = []
        for p in self.players.values():
            d = {"id": p["id"], "name": p["name"], "color": p["color"],
                 "x": round(p["x"], 2), "y": round(p["y"], 2), "z": round(p["z"], 2),
                 "ry": round(p["ry"], 2), "w": round(p["warmth"], 1), "h": round(p["hunger"], 1),
                 "c": p["carry"], "can": p["can"], "f": round(p["frozen"], 1), "in": p["inside"],
                 "axe": 1 if p["axe"] else 0, "rod": 1 if p["rod"] else 0,
                 "meat": p["meat"], "fish": p["fish"], "part": p["part"] or "",
                 "ft": round(p["fishT"], 1), "fh": p["fishHole"],
                 "kb": 1 if p["kb"] else 0, "inB": 1 if p["inB"] else 0,
                 "lost": 1 if p["lost"] else 0, "fly": round(p["fly"], 1)}
            if p.pop("teleport", False):
                d["tp"] = 1
            players.append(d)
        h = self.heli
        return {
            "t": "state", "m": round(self.minutes, 2), "phase": self.phase,
            "gale": round(self.gale_strength(), 3), "round": self.round_no, "day": self.day,
            "dawnIn": round(self.dawn_timer, 1) if self.phase == "dawn" else 0,
            "players": players,
            "cabins": [{"fuel": round(c["fuel"], 1), "wood": c["wood"],
                        "candles": [1 if v > 0 else 0 for v in c["candles"]],
                        "cans": c["cans"], "pot": round(c["pot"], 1), "pk": c["potKind"]}
                       for c in self.cabins],
            "logs": [[l["id"], l["x"], l["z"], l["r"]] for l in self.logs.values()],
            "items": [[i["id"], i["kind"], i["x"], i["z"]] for i in self.items.values()],
            "animals": [[a["id"], a["kind"], round(a["x"], 2), round(a["z"], 2), round(a["ry"], 2),
                         round(a["spd"], 1)] for a in self.animals.values()],
            "heli": {"parts": h["parts"], "run": h["running"], "x": round(h["x"], 2),
                     "z": round(h["z"], 2), "fly": round(h["fly"], 2)},
            "siren": self.siren, "impact": self.impact, "bunker": self.bunker,
            "events": self.events,
            "summary": self.summary if self.phase == "dawn" else None,
        }

    def broadcast(self, msg):
        data = json.dumps(msg, separators=(",", ":"))
        for c in list(self.clients.values()):
            c.send_text(data)


# ------------------------------------------------------------ websocket ---
class Client:
    def __init__(self, writer):
        self.writer = writer
        self.closed = False

    def send_text(self, text):
        if self.closed:
            return
        try:
            # drop updates for a client that has fallen far behind
            if self.writer.transport.get_write_buffer_size() > 2_000_000:
                return
            payload = text.encode("utf-8")
            n = len(payload)
            if n < 126:
                header = struct.pack("!BB", 0x81, n)
            elif n < 65536:
                header = struct.pack("!BBH", 0x81, 126, n)
            else:
                header = struct.pack("!BBQ", 0x81, 127, n)
            self.writer.write(header + payload)
        except Exception:
            self.closed = True


async def read_frame(reader):
    b1, b2 = await reader.readexactly(2)
    opcode = b1 & 0x0F
    fin = b1 & 0x80
    n = b2 & 0x7F
    if n == 126:
        n = struct.unpack("!H", await reader.readexactly(2))[0]
    elif n == 127:
        n = struct.unpack("!Q", await reader.readexactly(8))[0]
    if n > 1_000_000:
        raise ConnectionError("frame too big")
    mask = await reader.readexactly(4) if b2 & 0x80 else b"\0\0\0\0"
    data = bytearray(await reader.readexactly(n))
    for i in range(n):
        data[i] ^= mask[i & 3]
    return fin, opcode, bytes(data)


GAME = None


async def handle_ws(reader, writer, headers):
    key = headers.get("sec-websocket-key", "")
    accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
    writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                  "Connection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n" % accept).encode())
    await writer.drain()
    client = Client(writer)
    pid = None
    buf = b""
    try:
        while True:
            fin, op, data = await read_frame(reader)
            if op == 8:
                break
            if op == 9:
                writer.write(struct.pack("!BB", 0x8A, len(data)) + data)
                continue
            if op in (1, 0):
                buf += data
                if not fin:
                    continue
                text, buf = buf.decode("utf-8", "ignore"), b""
                try:
                    m = json.loads(text)
                except ValueError:
                    continue
                if not isinstance(m, dict):
                    continue
                t = m.get("t")
                if pid is None:
                    if t == "join":
                        pid = GAME.add_player(client, m.get("name"), m.get("color"))
                        client.send_text(json.dumps({"t": "welcome", "id": pid,
                                                     "world": GAME.world_info()}))
                    continue
                p = GAME.players.get(pid)
                if not p:
                    break
                if t == "pos":
                    GAME.on_pos(p, m)
                elif t == "act":
                    GAME.on_act(p, m)
                elif t == "chat":
                    GAME.on_chat(p, m)
    except (asyncio.IncompleteReadError, ConnectionError, OSError):
        pass
    finally:
        client.closed = True
        if pid is not None:
            GAME.remove_player(pid)
        try:
            writer.close()
        except Exception:
            pass


async def handle(reader, writer):
    try:
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 15)
    except Exception:
        writer.close()
        return
    lines = head.decode("latin-1").split("\r\n")
    try:
        method, path, _ = lines[0].split(" ", 2)
    except ValueError:
        writer.close()
        return
    headers = {}
    for ln in lines[1:]:
        if ":" in ln:
            k, v = ln.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    if headers.get("upgrade", "").lower() == "websocket":
        await handle_ws(reader, writer, headers)
        return
    path = path.split("?", 1)[0]
    if path == "/":
        path = "/index.html"
    full = os.path.realpath(os.path.join(PUBLIC, path.lstrip("/")))
    if not full.startswith(os.path.realpath(PUBLIC)) or not os.path.isfile(full):
        body = b"Not found"
        writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: %d\r\nConnection: close\r\n\r\n" % len(body) + body)
    else:
        with open(full, "rb") as f:
            body = f.read()
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if full.endswith(".js"):
            ctype = "text/javascript"
        writer.write(("HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %d\r\n"
                      "Cache-Control: no-cache\r\nConnection: close\r\n\r\n" % (ctype, len(body))).encode() + body)
    try:
        await writer.drain()
    finally:
        writer.close()


async def game_loop():
    last = time.monotonic()
    while True:
        await asyncio.sleep(0.1)
        now = time.monotonic()
        dt = min(0.5, now - last)
        last = now
        GAME.step(dt)
        GAME.broadcast(GAME.snapshot())
        GAME.events = []


def lan_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith("127.")) or ["127.0.0.1"]


def is_frostfall(port):
    """True if the program already on this port is a Frostfall Cabins server."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1.5) as s:
            s.sendall(b"GET /index.html HTTP/1.0\r\nHost: localhost\r\n\r\n")
            data = b""
            while len(data) < 65536:
                chunk = s.recv(8192)
                if not chunk:
                    break
                data += chunk
        return b"Frostfall <span>Cabins</span>" in data
    except OSError:
        return False


async def main():
    global GAME
    ap = argparse.ArgumentParser(description="Frostfall Cabins LAN server")
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--minutes", type=float, default=12, help="real minutes per night (default 12)")
    ap.add_argument("--day", type=int, default=1, help="start on day 1-4")
    args = ap.parse_args()
    GAME = Game(max(2.0, args.minutes) * 60, args.day)
    server, port = None, args.port
    for port in range(args.port, args.port + 20):
        try:
            server = await asyncio.start_server(handle, "0.0.0.0", port)
            break
        except OSError:
            if is_frostfall(port):
                # a Frostfall Cabins server is already up - just point people at it
                print("\n  ❄  Frostfall Cabins is ALREADY running on this computer.\n")
                for ip in lan_ips():
                    print("     Join on your network:  http://%s:%d" % (ip, port))
                print("     On this machine:       http://localhost:%d" % port)
                print("\n  (Close its other window first if you want to restart it.)\n")
                return
            print("  Port %d is used by another program - trying %d..." % (port, port + 1))
    if server is None:
        print("\n  Couldn't find a free port between %d and %d." % (args.port, args.port + 19))
        print("  Try:  python3 server.py --port 9100\n")
        return
    print("\n  ❄  FROSTFALL CABINS server is running\n")
    for ip in lan_ips():
        print("     Join on your network:  http://%s:%d" % (ip, port))
    print("     On this machine:       http://localhost:%d" % port)
    print("\n  Night length: %.0f min.  Press Ctrl+C to stop.\n" % (GAME.night_seconds / 60))
    asyncio.create_task(game_loop())
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n  Server stopped. Stay warm!\n")
