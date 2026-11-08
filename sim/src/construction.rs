//! Construction system (SPEC §2.3 Build / M1-T10): Rust port of
//! `src/sim/systems/construction.ts`. Assigned builders walk to the
//! footprint approach band and add fixed-point progress with
//! diminishing per-builder returns (k-th in-range builder adds
//! round(1000·0.7^k) milli-ticks, scaled by skill/trait/rest/injury/
//! deprivation multipliers); completion swaps the site into its
//! finished building on the same entity id and releases builders.
//! Sites holding tools run ×5/4 and drain one tool per 90 ticks.
use crate::activities::{cancel_activities, move_activity, peek};
use crate::buildings::{assign_site, building_site_row, clear_assigned_site, complete_building, BuildingComps, FootprintRect};
use crate::core::{Command, Eid, World as CoreWorld};
use crate::defs::Defs;
use crate::economy::{clear_assigned_node, commodity_amount_or_zero, withdraw_commodity, EconomyComps};
use crate::mapgen::Layers;
use crate::movement::{read_queue, reset_steering_bookkeeping, write_queue, MovementComps};
use crate::pop::{self, js_round, PopComps, TraitsData, CONSTRUCTION_XP_PER_TICK};
use std::collections::BTreeMap;
use std::sync::Arc;

pub const BUILD_KIND: &str = "build";
pub const WORK_MILLI_SCALE: f64 = 1000.0;
pub const EXTRA_BUILDER_EFFICIENCY: f64 = 0.7;
pub const BUILD_WORK_RANGE_TILES: f64 = 3.25;
const TOOLS_BOOST_NUMERATOR: f64 = 5.0;
const TOOLS_BOOST_DENOMINATOR: f64 = 4.0;
const TOOLS_CONSUME_PERIOD_TICKS: u64 = 90;
const COMMODITY_TOOLS: i64 = 2;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ConstructionDiagnostics {
    pub commands_applied: u64,
    pub completions: u64,
    pub tools_consumed: u64,
    pub boosted_site_ticks: u64,
}

pub fn builder_work_milli_per_tick(rank: u32) -> f64 {
    let mut weight = 1.0f64;
    for _ in 0..rank {
        weight *= EXTRA_BUILDER_EFFICIENCY;
    }
    js_round(WORK_MILLI_SCALE * weight)
}

pub fn rect_distance_sq(x: f64, y: f64, rect: &FootprintRect) -> f64 {
    let dx = (rect.x - x).max(0.0).max(x - (rect.x + rect.width));
    let dy = (rect.y - y).max(0.0).max(y - (rect.y + rect.height));
    dx * dx + dy * dy
}

fn passable_at(passability: &[u8], size: usize, x: i64, y: i64) -> bool {
    if x < 0 || y < 0 || x >= size as i64 || y >= size as i64 {
        return false;
    }
    passability[y as usize * size + x as usize] == 1
}

/// Nearest point on the margin-expanded rect, slid to the nearest
/// passable tile (expanding rings) when blocked. Shared with
/// production in TS.
pub fn approach_point(layers: &Layers, rect: &FootprintRect, margin: f64, from_x: f64, from_y: f64) -> (f64, f64) {
    let min_x = rect.x - margin;
    let min_y = rect.y - margin;
    let max_x = rect.x + rect.width + margin;
    let max_y = rect.y + rect.height + margin;
    let cx = from_x.clamp(min_x, max_x);
    let cy = from_y.clamp(min_y, max_y);
    let size = layers.size;
    let passability = &layers.passability;
    let (start_tx, start_ty) = (cx.floor() as i64, cy.floor() as i64);
    if passable_at(passability, size, start_tx, start_ty) {
        return (cx, cy);
    }
    for ring in 1..=(size as i64) {
        let lo_x = (start_tx - ring).max(0);
        let lo_y = (start_ty - ring).max(0);
        let hi_x = (start_tx + ring).min(size as i64 - 1);
        let hi_y = (start_ty + ring).min(size as i64 - 1);
        for x in lo_x..=hi_x {
            if passable_at(passability, size, x, lo_y) {
                return (x as f64 + 0.5, lo_y as f64 + 0.5);
            }
        }
        for y in (lo_y + 1)..=hi_y {
            if passable_at(passability, size, hi_x, y) {
                return (hi_x as f64 + 0.5, y as f64 + 0.5);
            }
        }
        for x in (lo_x..hi_x).rev() {
            if passable_at(passability, size, x, hi_y) {
                return (x as f64 + 0.5, hi_y as f64 + 0.5);
            }
        }
        for y in (lo_y + 1..hi_y).rev() {
            if passable_at(passability, size, lo_x, y) {
                return (lo_x as f64 + 0.5, y as f64 + 0.5);
            }
        }
    }
    (cx, cy)
}

fn row(world: &CoreWorld, component: usize, eid: Eid) -> Option<&Vec<f64>> {
    world.rows_by_component.get(component).and_then(|r| r.get(&eid))
}

struct ParsedBuild {
    entity_ids: Vec<Eid>,
    site_eid: Eid,
    queue: bool,
}

fn parse_build_data(data: &serde_json::Value) -> ParsedBuild {
    let raw_ids = data.get("entityIds").and_then(|v| v.as_array());
    let raw_ids = raw_ids.filter(|a| !a.is_empty()).expect("build requires a non-empty entityIds array");
    let mut entity_ids: Vec<Eid> = Vec::new();
    for id in raw_ids {
        let id = id
            .as_f64()
            .filter(|v| v.fract() == 0.0 && *v >= 1.0)
            .map(|v| v as Eid)
            .unwrap_or_else(|| panic!("build entityIds entries must be positive integers, got {id}"));
        if !entity_ids.contains(&id) {
            entity_ids.push(id);
        }
    }
    entity_ids.sort();
    let site_eid = data
        .get("siteEid")
        .and_then(|v| v.as_f64())
        .filter(|v| v.fract() == 0.0 && *v >= 1.0)
        .map(|v| v as Eid)
        .unwrap_or_else(|| panic!("build siteEid must be a positive integer"));
    ParsedBuild { entity_ids, site_eid, queue: data.get("queue").and_then(|v| v.as_bool()) == Some(true) }
}

struct BuilderRef {
    eid: Eid,
    x: f64,
    y: f64,
    has_vel: bool,
}

struct SiteGroup {
    owner: f64,
    def_code: f64,
    rect: FootprintRect,
    builders: Vec<BuilderRef>,
}

pub struct ConstructionSystem {
    defs: Arc<Defs>,
    traits: Arc<TraitsData>,
    pop: PopComps,
    bcomps: BuildingComps,
    pub diagnostics: ConstructionDiagnostics,
}

impl ConstructionSystem {
    pub fn new(defs: Arc<Defs>, traits: Arc<TraitsData>, pop: PopComps, bcomps: BuildingComps) -> ConstructionSystem {
        ConstructionSystem { defs, traits, pop, bcomps, diagnostics: ConstructionDiagnostics::default() }
    }

    fn reset_steering(&self, world: &mut CoreWorld, comps: &MovementComps, eid: Eid) {
        if let Some(vel) = world.rows_by_component.get_mut(comps.velocity).and_then(|r| r.get_mut(&eid)) {
            reset_steering_bookkeeping(vel);
        }
    }

    fn set_move_target(&self, world: &mut CoreWorld, comps: &MovementComps, eid: Eid, x: f64, y: f64) {
        assert!(row(world, comps.move_target, eid).is_some(), "entity {eid} has no MoveTarget row");
        world.set_values(comps.move_target, eid, &[x, y]).expect("registered component");
    }

    pub fn run(&mut self, world: &mut CoreWorld, comps: &MovementComps, econ: &EconomyComps, layers: &Layers, commands: &[Command]) {
        // 1) Commands on their target tick boundary.
        for command in commands {
            if command.kind != BUILD_KIND {
                continue;
            }
            let data = command.data.as_ref().expect("build requires command data");
            let parsed = parse_build_data(data);
            if building_site_row(world, &self.bcomps, parsed.site_eid).is_none() {
                panic!("build command targets entity {}, which has no BuildingSite row", parsed.site_eid);
            }
            for eid in parsed.entity_ids {
                let live = row(world, comps.position, eid).is_some()
                    && row(world, comps.velocity, eid).is_some()
                    && row(world, comps.unit_tag, eid).is_some();
                if !live {
                    continue;
                }
                if pop::is_child(world, &self.pop, eid) {
                    continue;
                }
                clear_assigned_node(world, econ, eid);
                assign_site(world, &self.bcomps, eid, parsed.site_eid);
                let mut queue = read_queue(world, comps, eid);
                if !(parsed.queue && !queue.is_empty()) {
                    cancel_activities(&mut queue);
                    write_queue(world, comps, eid, &queue);
                    self.reset_steering(world, comps, eid);
                }
            }
            self.diagnostics.commands_applied += 1;
        }

        // 2) Group assigned builders per live site, ascending eid.
        let mut groups: BTreeMap<Eid, SiteGroup> = BTreeMap::new();
        let mut released: Vec<Eid> = Vec::new();
        for &eid in &world.entities {
            let Some(site_eid) = crate::buildings::assigned_site(world, &self.bcomps, eid) else { continue };
            let (Some(pos), true) = (row(world, comps.position, eid), row(world, comps.unit_tag, eid).is_some()) else {
                continue;
            };
            let (px, py) = (pos[0], pos[1]);
            let site_row = building_site_row(world, &self.bcomps, site_eid).cloned();
            let site_pos = row(world, comps.position, site_eid).cloned();
            let (Some(site_row), Some(site_pos)) = (site_row, site_pos) else {
                released.push(eid);
                continue;
            };
            let group = groups.entry(site_eid).or_insert_with(|| {
                let def = self.defs.building(self.defs.building_id_of_code(site_row[1] as u32));
                SiteGroup {
                    owner: site_row[0],
                    def_code: site_row[1],
                    rect: FootprintRect {
                        x: site_pos[0] - def.footprint.width as f64 / 2.0,
                        y: site_pos[1] - def.footprint.height as f64 / 2.0,
                        width: def.footprint.width as f64,
                        height: def.footprint.height as f64,
                    },
                    builders: Vec::new(),
                }
            });
            group.builders.push(BuilderRef {
                eid,
                x: px,
                y: py,
                has_vel: row(world, comps.velocity, eid).is_some(),
            });
        }
        for eid in released {
            clear_assigned_site(world, &self.bcomps, eid);
        }

        // 3) Advance each site (ascending eid via BTreeMap).
        let range_sq = BUILD_WORK_RANGE_TILES * BUILD_WORK_RANGE_TILES;
        let site_eids: Vec<Eid> = groups.keys().copied().collect();
        for site_eid in site_eids {
            let group = &groups[&site_eid];
            let total_needed =
                self.defs.building(self.defs.building_id_of_code(group.def_code as u32)).build_time as f64 * WORK_MILLI_SCALE;

            let mut milli_this_tick = 0.0f64;
            let mut contributing_rank = 0u32;
            for builder in &group.builders {
                if rect_distance_sq(builder.x, builder.y, &group.rect) <= range_sq {
                    let level = pop::skill_level(world, &self.pop, builder.eid, "construction").unwrap_or(0);
                    let mut milli = pop::builder_milli_per_tick_for(
                        builder_work_milli_per_tick(contributing_rank),
                        level,
                        pop::work_trait_mult(world, &self.pop, &self.traits, builder.eid),
                    );
                    let rest_mult = pop::rest_work_multiplier(world, &self.pop, builder.eid);
                    if rest_mult != 1.0 {
                        milli = js_round(milli * rest_mult);
                    }
                    let deprived_mult = pop::deprivation_work_multiplier(world, &self.pop, builder.eid);
                    if deprived_mult != 1.0 {
                        milli = js_round(milli * deprived_mult);
                    }
                    let injury_mult = pop::injury_impairment(world, &self.pop, builder.eid).work_mult;
                    if injury_mult != 1.0 {
                        milli = js_round(milli * injury_mult);
                    }
                    milli_this_tick += milli;
                    pop::award_practice(world, &self.pop, &self.traits, builder.eid, "construction", CONSTRUCTION_XP_PER_TICK);
                    contributing_rank += 1;
                }
            }

            if milli_this_tick > 0.0 && commodity_amount_or_zero(world, econ, group.owner, COMMODITY_TOOLS) > 0.0 {
                milli_this_tick = (milli_this_tick * TOOLS_BOOST_NUMERATOR / TOOLS_BOOST_DENOMINATOR).floor();
                self.diagnostics.boosted_site_ticks += 1;
                if world.tick % TOOLS_CONSUME_PERIOD_TICKS == 0 {
                    withdraw_commodity(world, econ, group.owner, COMMODITY_TOOLS, 1.0).expect("tool withdraw");
                    self.diagnostics.tools_consumed += 1;
                }
            }

            if milli_this_tick > 0.0 {
                let r = world.rows_by_component.get_mut(self.bcomps.building_site).unwrap().get_mut(&site_eid).expect("site row");
                r[2] = (r[2] + milli_this_tick).min(total_needed);
            }

            // Planning: idle out-of-range builders walk to their door.
            for builder in &group.builders {
                if rect_distance_sq(builder.x, builder.y, &group.rect) > range_sq {
                    let mut queue = read_queue(world, comps, builder.eid);
                    if peek(&queue).is_none() {
                        let door = approach_point(layers, &group.rect, 0.75, builder.x, builder.y);
                        queue.push(move_activity(&[door.0, door.1]).expect("move activity"));
                        write_queue(world, comps, builder.eid, &queue);
                        self.set_move_target(world, comps, builder.eid, door.0, door.1);
                        if builder.has_vel {
                            self.reset_steering(world, comps, builder.eid);
                        }
                    }
                }
            }

            // Completion after this tick's progress lands.
            let progress = building_site_row(world, &self.bcomps, site_eid).map(|r| r[2]).unwrap_or(0.0);
            if progress >= total_needed {
                complete_building(world, comps, &self.bcomps, econ, &self.defs, site_eid);
                self.diagnostics.completions += 1;
                for builder in &group.builders {
                    clear_assigned_site(world, &self.bcomps, builder.eid);
                    let mut queue = read_queue(world, comps, builder.eid);
                    cancel_activities(&mut queue);
                    write_queue(world, comps, builder.eid, &queue);
                }
            }
        }
    }
}
