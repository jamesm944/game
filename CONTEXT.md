# Age of Empires-like RTS

A browser-based, single-player real-time strategy game that uses Age of Empires 2 as its base model and deliberately exceeds it: extra resources and production chains, Dwarf-Fortress-style individually simulated Pops with generational lifecycle, RPG-flavored per-Pop combat growth, and Civilization-style multiple victory paths. Personal-use only.

## Language

### Pops

**Pop**:
An individually simulated person — the atomic unit of economy, combat, and society. Has age, family, skills, traits, health, and a job.
_Avoid_: Unit (for workers), citizen, villager-as-individual

**Villager role**:
The labor assignment a working-age Pop holds (gatherer, builder, farmer). A job, not an identity — Pops cycle through roles.
_Avoid_: Villager (when meaning the individual)

**Child**:
A young Pop; cannot work or fight, acquires traits at School, becomes an adult at the age gate.
_Avoid_: Kid

**Elder**:
A Pop past working age; light duties only, carries accumulated knowledge bonuses where modeled.

**Lifecycle**:
Birth → childhood → adulthood → elderhood → death. Aging advances in sim time; death is permanent and individual.

**Family / Household**:
The unit binding related Pops (parents, children) to a home. Drives household formation, morale, and birth rates.

**Skill**:
A trained capability of a Pop (mining, archery, melee…) that improves with use and decays without practice.
_Avoid_: Level (bare), stat

**Trait**:
A stable characteristic of a Pop — some innate/random at birth, some acquired at School — modifying work speed, combat behavior, or needs.
_Avoid_: Perk, feature

**Injury**:
Damage to a specific Pop that persists across ticks: impairs work/combat while present, heals over time or maims permanently.

**Needs**:
The three per-Pop meters — food, rest, morale — decayed only on the Pop's hash-offset rare tick. Hunger sends a Pop to eat from the stockpile; starvation crashes morale; a drained rest meter slows work until full sleep arrives (T6).
_Avoid_: Happiness, hunger bar (bare), stats

**Rare tick**:
An entity's personal slow-update slot, `(tick + eid) % 250`, shared by needs decay and skill rust — expensive per-Pop bookkeeping amortized across the population instead of spiked every tick.
_Avoid_: Lazy tick, timer

**IAUS job brain**:
The 1 Hz utility scorer that self-assigns IDLE named Pops to gather nodes, build sites and production slots through the plain command interface. Player orders always win: ordered Pops are simply invisible to it.
_Avoid_: Auto-worker, AI (bare), macro

**Job cooldown**:
The DFHack-style window stamped ON a target after a brain assignment, refusing further brain assignments there until it lapses — anti-thrash plus natural labor spreading. Digest-visible state on the target entity.
_Avoid_: Lock, blacklist

**School**:
The building where Children spend childhood gaining traits and early skills before entering the workforce.

### Economy

**Resource**:
A gatherable raw material. The seven §2.6 gatherables live since M2-T2: Food, Wood, Gold, Stone plus Iron, Coal, Clay.
_Avoid_: Material, currency

**Carry capacity**:
The maximum amount of one Resource a Pop holds before depositing at a Drop-off point.
_Avoid_: Load, inventory

**Drop-off point**:
A building where a Pop deposits carried Resources into the stockpile. Each declares an acceptance filter list (`dropoffFilters`); carriers route to the cheapest ACCEPTING point and a rejected resource is never credited (M2-T2).
_Avoid_: Depot

**Commodity**:
A crafted good produced from Resources via a Recipe (planks, bricks, tools, weapons, armor, meals). Not gathered — made.
_Avoid_: Product, item

**Recipe**:
The data definition turning input Resources/Commodities into an output Commodity at a required building, gated by techs.
_Avoid_: Crafting rule

**Farm re-seeding**:
Rebuilding a depleted Farm for a wood cost so it continues producing Food indefinitely.

**Age**:
The per-player ladder rung — Dark, Feudal, Castle, Imperial (ranks 1–4). Every Entity definition carries an `ageGate`; content is usable only once the owner's rank reaches it. Advanced by researching age techs at the Town Center (`researchAge`); completions append digest-visible AgeAdvanced events.
_Avoid_: Era, tier

### Delegated management

**Workplace**:
A production building plus its associated work area — the unit a Foreman manages.
_Avoid_: Job site, facility

**Foreman**:
A Pop appointed to run one Workplace: fills its slots from the labor pool, rotates tired workers, handles re-seeding and rebuilds. Quality derives from the individual's traits and Management skill.
_Avoid_: Overseer, boss

**Manager**:
A Pop appointed over one resource domain (Food, Wood, Stone·Clay, Metal, Crafted) who redistributes workers across its workplaces per player-set strategy weights.
_Avoid_: Governor, administrator

**Staffing rule**:
Player appoints Foremen/Managers only on directly-owned Workplaces; a Branch is staffed exclusively by its Company — no player appointment or veto there.
_Avoid_: Veto power

**Strategy weight**:
The player-set priority slider a Manager obeys when reallocating workers within their domain.
_Avoid_: Priority flag

**Company**:
A player-chartered organization owning Workplaces as Branches, holding a treasury from a share of branch output, and proposing new branches autonomously.
_Avoid_: Corporation, business (bare)

**Branch**:
A Workplace owned by a Company rather than directly by the player.
_Avoid_: Franchise, office

**Treasury**:
A Company's virtual credit ledger, funded by its Branches' output share; spendable only on the Company's own proposals.
_Avoid_: Bank, fund

**Charter**:
A Company's founding focus and rules: name, sector, expansion approval mode.
_Avoid_: License

**Expansion proposal**:
The Company's autonomous plan for one new Branch — treasury-funded, sited by the AI's placement scorer beside an unclaimed resource node — produced only when every §2.7 hold passes (treasury ≥ threshold · node in reach · labor slack ≥ N · valid footprint · not frozen).
_Avoid_: Auto-build (bare), expansion plan

**Approval mode**:
Per-company expansion policy: **always-ask** stamps a pending proposal the player approves or rejects; **auto-approve** breaks ground the moment the proposal forms.
_Avoid_: Permission level

**Organic founding**:
The spontaneous origin (§2.7): when one sector holds ≥3 profitable directly-owned Workplaces and a sufficiently management-rated Pop exists, that Pop founds a company on the daily scan, absorbing them as Branches.
_Avoid_: Spin-off, startup

**Grace window**:
The short span after an organic founding during which dissolveCompany is free of charge; past it, dissolution costs the owner gold severance.
_Avoid_: Free period (bare)

**Seize**:
Player oversight action taking one Branch back under direct control; its company-appointed foreman post dies with the transfer.
_Avoid_: Nationalize

**Dissolve**:
Player oversight action ending a company: Pops and workplaces revert to direct ownership, all company rows die with the entity.
_Avoid_: Disband (bare)

### AI opponent

**AI opponent**:
The single scripted adversary (player slot 1) that plays through the SAME command interface as the human — never by mutating sim state directly.
_Avoid_: Bot, CPU, computer player

**Fog honesty**:
The structural guarantee that the AI can only know what its fog planes allow: enemy queries go through a surface with no API to ask about unseen entities, so wallhacks are impossible by construction.
_Avoid_: Line of sight check, cheat

**KnowledgeView**:
The fog-curated query surface over one viewer's planes — own entities always, enemies only while observed, plus memory ghosts. Backs the AI, replays and future observers alike.
_Avoid_: World state, entity list

**Memory ghost**:
The last-known record of an enemy building that left visibility; persists until re-sighted or observed destroyed. Invisible to combat and simulation.
_Avoid_: Ghost building (bare)

**Build-order layer**:
Layer 1 of the AI planner: scripted gated strategies as data (fast-castle-knights, scouts-rush, archers-push) whose steps carry completion conditions, resource/age gates and `requires` edges.
_Avoid_: Opening, build order script (bare)

**Economy manager**:
Layer 2 of the AI planner: keeps the town-center villager queue saturated toward the strategy target, places houses ahead of demand, pulls builders above a gatherer floor, and balances idle villagers onto resources per strategy weights.
_Avoid_: Worker assigner, macro

**Planning pass**:
The AI's full think cycle, run every 30 ticks (1 s) with cheap incremental checks between; amortized cost stays under 1 ms.
_Avoid_: Tick logic, update loop

**Command draft**:
A plain `{kind, data}` descriptor the AI emits for the orchestrator to submit into the shared inbox at the next tick boundary — identical in kind to a human click.
_Avoid_: Direct order, API call

### Combat & progression

**Armor class**:
A tag on units/buildings (infantry, cavalry, archer, siege, building…) that Attack bonuses key off.
_Avoid_: Type, category

**Attack bonus**:
Extra damage vs a specific Armor class, defined in data. Creates the counter triangle.

**Counter triangle**:
Emergent infantry → archer → cavalry → infantry loop (plus siege → buildings).

**Derived stats**:
Combat numbers (attack, per-class armor, speed, range, reload) computed ON READ from the Entity definition plus equipped commodity counts plus researched techs — never stored in a duplicate row. Traits contribute zero until M3.
_Avoid_: Stat block, cached stats

**Equipment**:
Forge Weapons/Armor commodities consumed onto a military Pop (SPEC §2.5 "equipment = commodities"): each piece adds a flat documented attack/armor delta in the Derived-stats read. There is no separate gear inventory — the CommodityStockpile IS the armory.
_Avoid_: Item, gear slot inventory

**Engagement**:
The live attacker→target binding held in a unit's Combat row; the target may be another unit OR a structure (M2-T7). Broken by death, disengagement validation after foreign orders, or purge when the target dies. Acquired three ways: explicit attack command (units and structures), auto-retaliation when damaged in range, aggro acquisition while attack-moving (units only).

**Attack-move**:
A march that watches for enemies inside the unit's sight radius and pauses to fight, resuming automatically once the engagement ends. Group attack-marches reuse the formation slots of plain moves (one leader path, concentric-ring deal).

**Retaliation**:
Auto-acquiring your striker as target when damaged inside aggro range; pauses (never cancels) the current job, which resumes after the fight.

**Age advancement**:
Moving the settlement up Dark → Feudal → Castle → Imperial by paying at an advancing building; gates units, buildings, techs.
_Avoid_: Era, level up

**Structure targeting**:
Buildings and construction sites are legal Attack targets without holding a Combat row (M2-T7): strikes run the same counter formula against the canonical `building` Armor class; structures never retaliate and are invisible to aggro acquisition.
_Avoid_: Building combat

**Rubble**:
The residue entity spawned over a destroyed structure's footprint (M2-T7). Pure marker state on its own entity id; rebuild/repair flows arrive later.
_Avoid_: Wreck, ruin tile

**Morale shock**:
A morale-meter hit triggered by combat events (M3-T9): family/companion deaths and blows taken. Every shock funnels through the bond buffer — a Pop's strongest Relationship softens the landing — so bonded Pops measurably out-grieve strangers.

**Break point**:
The individual morale threshold, derived on read from nerve traits (brave/coward/optimistic/pessimistic), melee veterancy and open wounds. Dropping to or below it ON A SHOCK breaks the Pop.
_Avoid_: Courage stat, stored threshold

**Routing**:
Post-break flight (SPEC §2.5, M3-T9): the Pop flees its living threat, sheds engagements, ignores every order, can be attacked down but never fights back — until RALLIED or SAFE.
_Avoid_: Fleeing (bare), retreat

**Rally**:
Recovery of a router: nearby same-owner allies whose own morale is high restore meter per rare tick until break-point-plus-margin clears (rallied exit); a dead or far-away threat ends the episode immediately instead (safe exit).

**Unit death**:
A combatant's death, logged on the victim owner's ledger with its own CombatEvents kind (M2-T10) so fallen units count separately from razed structures — the stats recap reads exactly this.
_Avoid_: Casualty (bare), kill (from the victim side)

**Destruction**:
What happens when a structure's hp reaches zero (M2-T7), in pinned order: DEATH event on the owner log → workers whose site/job pointed there released to idle → footprint tiles freed + passabilityVersion bump (repath invalidation) → Rubble spawns → attackers drop their engagements → every functional row (Drop-off, Train queue, Production cycle) dies with the entity.

**Technology**:
A purchasable permanent modifier to units, buildings, or civilization. Bought via the Tech tree.

**Tech tree**:
The full graph of buildings, units, technologies and their prerequisites.

**Entity definition**:
The JSON record for one unit/building/technology/recipe: costs, stats, Armor classes, bonuses, prerequisites, asset refs. All rules are Entity definitions + shared systems.
_Avoid_: Config, blueprint

### Schedules & social life

**Day/night cycle**:
The 24-hour sim clock driving work, sleep, and leisure windows; rendered as lighting tint only.
_Avoid_: Time of day (bare), circadian system

**Schedule**:
A Pop's recurring daily pattern of work window, sleep window at its Household home, and free leisure time.
_Avoid_: Routine, timetable

**Leisure activity**:
A personality-scored off-work choice (tavern, brothel, visiting friends/family, shrine, study) paid for in gold or time and returning morale or bond effects.
_Avoid_: Recreation, hobby

**Social bond**:
A pairwise Relationship value between two Pops, built by visits and shared events; strong bonds buffer morale shocks.
_Avoid_: Friendship level

**Venue**:
A building type hosting Leisure activities (Tavern, Brothel, Shrine, School-library).
_Avoid_: Hotspot, hangout

**Rest day**:
Sunday of the 7-day week: work windows close (essential roles only) and the community attends Mass if a Church stands.
_Avoid_: Weekend, holiday

**Mass**:
The communal Sunday morning gathering at a Church — broad morale buff and Social-bond reinforcement across attendees.
_Avoid_: Service (bare)

**Work activity**:
The visible, looping task a Pop performs at a work slot — axe swings at trees, pick strikes in mines, hammering on sites — matched to an animation clip and tool prop.
_Avoid_: Job (the assignment), chore

**Cargo prop**:
The visible bundle (logs, ore sack, food basket) rendered attached to a Pop while carrying resources back to a Drop-off point.
_Avoid_: Backpack, load mesh

### Victory

**Victory path**:
One of several alternative win routes (Civ-style): Conquest plus knowledge/culture/economic/diplomatic-style paths as decided in design tickets.
_Avoid_: Win condition (when listing them all)

**Victory evaluator**:
The §2.11 frame as one symmetric system: generator → accumulating metric → completing act → hold timer (timerless for Conquest). Every side runs the SAME code path; the decision freezes the match.
_Avoid_: Win checker, victory logic

**Conquest victory**: destroy enemy military production capacity (standard) — the live count of Barracks, Archery Range and Stable buildings per player (M2-T7 helper, consumed by the T10 evaluator). A player is defeated only after having HELD such capacity (read off their VictoryCheck log); economic-only play cannot be conquered until the other paths exist.
**Wonder victory**: complete a Wonder, hold through timer.
**Relic victory**: hold all Relics through timer.
**Knowledge victory**: build the Grand Academy and sustain ≥N KP/min for T minutes. Generators: School lessons (KP scaled by teacher level) plus a lump award per completed research.
**Culture victory**: build the Grand Monument and sustain ≥N prestige/min for T minutes. Generators: Monuments' ongoing income, population happiness/morale surplus, and Festivals.
**Economic victory** (M4-T5): own ≥1 Company and sustain ≥N credits/min of aggregate Branch output market value for T minutes. The gate lives in the `economic-path` victory-path definition — the act is company ownership itself, no completing-act building.

**Relic**:
A neutral map pickup (grounded → carried → stored) tracked in one Relic row per entity. A player "holds" a relic only while it rests STORED inside their own finished Monastery; holding ALL relics arms the timer.
_Avoid_: Artifact, holy item (bare)

**Monk**:
The unit that carries relics to Monastery storage via the `collectRelic`/`depositRelic` commands. The v1 carry is a command-driven stub — no walk-to-pickup activity chain yet.
_Avoid_: Priest, cleric

**Hold-only path**:
A timed path with NO sustain threshold (Wonder, Relic): every heartbeat interval whose closing check finds the act standing counts toward the hold. Destruction is the cancel key — razing the Wonder or losing any relic freezes (and later resumes) the timer exactly like a broken sustain gate.
_Avoid_: Instant win, untimed path

**Branch output ledger**:
The economic path's cumulative counter — one BranchOutputLedger row per player in integer milli-credits, fed by the companies layer's output observer at every branch credit event (full market value, never just the treasury share).
_Avoid_: Treasury (that's the company's virtual share), income

**Victory-path definition**:
A fifth definition family (`kind: "victoryPath"` under `src/data/definitions/victory/`) pinning gates for paths whose completing act is not a building — the Economic threshold/timer today.
_Avoid_: Hardcoded threshold

**Knowledge Points (KP)**:
The cumulative per-player knowledge output on the ledger entity's KnowledgePoints row, carried in integer milli-units. The sustained KP/min metric is derived from this counter's deltas across the player's own VictoryCheck log — never from hidden state.
_Avoid_: Research points, science

**Prestige**:
The cultural counterpart of KP — one cumulative PrestigeLedger row per player, integer milli-units, fed by monuments, happiness surplus and festivals; the culture path sustains its rate off the same log-delta derivation.
_Avoid_: Culture points, glory

**Festival**:
A `hostFestival` command that converts Food+Gold into a timed prestige burst; costs and burst size live in the monument definition's §2.11 role block.
_Avoid_: Party, celebration (bare)

**Completing act**:
The building (or, for the economic path, the owned Company) that arms a timed path's win condition — Grand Academy (knowledge), Grand Monument (culture), the Wonder itself (wonder). Until it stands, no interval counts toward the hold timer even while output flows.
_Avoid_: Victory building, win structure

**Sustain gate**:
The completing act's paired JSON fields sustainPerMin + holdTicks: the minimum generator rate each cadence check must record, and how long the accumulated hold must last, to win.

**Sustaining heartbeat**:
A VictoryCheck status marking that, at that check, the completing act stood AND the interval since the previous check held the threshold rate — exactly the intervals the hold-timer sum reads, so pause/resume lives in digest rows only.
_Avoid_: Timer tick, progress flag

**VictoryCheck log**:
The append-only per-player evaluation record on each ledger entity — one entry every 30 ticks with the current metric, then the decisive WON/LOST/SURRENDERED tail. Digest-visible by construction.
_Avoid_: Score, progress bar state

**Surrender**:
A player's concede order entering the shared inbox like any command; the survivor wins immediately and the log freezes.
_Avoid_: Quit, resign (bare)

**Session bootstrap**:
The single two-player skirmish start (world + systems + bases + fog recompute) shared by production and tests; restart re-runs it from a fresh seed.
_Avoid_: Game init, setup code

### Rendering

**Render mirror**:
The double-buffered SoA snapshot of live Pop positions/headings that the renderer reads. The sim-side producer copies it after each step(); render only samples it with an interpolation alpha. Render never touches sim component rows directly.
_Avoid_: Snapshot state (bare), world copy

### Naval & Water Economy

**Dock**:
A 3×3 hybrid coastal structure that straddles land and water. Trained ships spawn in navigable water berths while land workers construct and repair it from adjacent land tiles. Serves as drop-off point for water food.
_Avoid_: Harbor, port (bare)

**Fishing Boat**:
A civilian vessel trained at the Dock that harvests food from water fish nodes and deposits carried cargo at coastal docks.
_Avoid_: Fisher, fishing ship

**Warship**:
Combat vessels trained at the Dock (Galley line, Fire Ship, Cannon Galleon) possessing armor class `ship` and navigating water tiles.
_Avoid_: Boat (for military ships)

**Water fish node**:
A resource node placed in water tiles containing harvestable Food (Shore Fish: 200 food, Deep-Sea: 350 food) gatherable exclusively by Fishing Boats.
_Avoid_: Fish school, fishing spot

### Civilizations & Asymmetry

**Civilization**:
The historical culture assigned to a player (Britons, Franks, Goths, Byzantines) that dictates passive bonuses, a Unique Unit, and a Unique Tech.
_Avoid_: Faction, race, tribe

**Unique Unit**:
A specialized military unit trained at the Castle (or Barracks via unique tech) exclusive to a specific Civilization (Longbowman, Throwing Axeman, Huskarl, Cataphract).
_Avoid_: Special unit, elite unit (when meaning base UU)

**Unique Technology**:
A Castle-age technology exclusive to a specific Civilization granting signature military or economic empowerment (Yeomen, Chivalry, Anarchy, Greek Fire).
_Avoid_: Civ upgrade, unique upgrade

**Civilization Bonus**:
An innate, passive modifier applied unconditionally to a player's units, buildings, costs, or gather activities based on their chosen Civilization.
_Avoid_: Passive buff, perk

### Modern RTS Quality of Life

**Multi-Building Queue Aggregation**:
Unified selection and production across multiple production buildings, presenting a unified trainable unit roster with capable building count badges and aggregate queue status.
_Avoid_: Batch selection (bare), multi-select queue (bare)

**Balanced Training**:
Greedy shortest-queue-first distribution of unit training commands across capable selected production buildings, tie-breaking by remaining ticks on head item and lowest entity ID.
_Avoid_: Round-robin (bare), auto-train

**Rally Point**:
An authoritative world coordinate or target entity assigned to a production building where newly spawned units are automatically routed upon training completion.
_Avoid_: Spawn waypoint, flag target (bare)

**Idle Villager Notification**:
An alert event (toast notification, audio chime `ui.idle`, and minimap pulse) triggered when working-age Pops become idle, providing click-to-camera-jump and auto-selection.
_Avoid_: Idle worker popup, worker buzzer

**Minimap Alert Ping**:
An animated expanding pulse ring rendered at specific world coordinates on the minimap to draw attention to critical events (idle villagers, attacks, flare signals).
_Avoid_: Radar blip, flare (when meaning automated alert)

### Tactical Formations & Command Queuing

**Waypoint Queuing**:
Sequential activity chaining achieved by holding Shift during right-click contextual orders, appending actions to an entity's ActivityQueue rather than immediately replacing the active command.
_Avoid_: Shift-queue (bare), order stacking

**Tactical Unit Formation**:
A geometric arrangement of units in a selected squad (AoE2 Line, Box, Staggered, Flank; Bannerlord Shield Wall, Square, Circle, Wedge) that dictates unit relative spacing, defense bonuses, and marching posture.
_Avoid_: Group shape, troop stance (when meaning formation geometry)

**Formation Speed Harmonization**:
The rule governing units marching in formation where all members throttle their movement speed to match the slowest unit in the formation, preserving relative slot geometry during transit.
_Avoid_: Slowdown, unit pacing
