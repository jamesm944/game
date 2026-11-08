//! Pop identity/traits/skills/needs/body rows + derived work
//! multipliers: Rust port of `src/sim/components/pop.ts`,
//! `components/skills.ts`, `components/needs.ts` (attach + constants),
//! `components/body.ts` (attach + impairment read), `data/traits.ts`,
//! `data/skills.ts` (level curve), and the read paths of
//! `systems/skills.ts` / `systems/needs.ts` / `systems/schedules.ts` /
//! `systems/lifecycle.ts` that gather and construction fold in.
//!
//! Row layouts are digest contract:
//! - Identity (4): [nameIdx, birthTick, familyId, origin]
//! - Traits (variable): ascending u8 trait codes
//! - Skills (variable, count-led, 5-int entries):
//!   [count, code, knowledgeXp, practiceXp, rustAccumulator,
//!    lastPracticeTick, …]
//! - Needs (3): [food, rest, morale] meters, 100 at attach
//! - Lessons (3): [0, -1, 0] at attach
//! - Body (variable, count-led injury stacks): [0] at attach
//!
//! The civ-bonus fold in TS resolveGatherInterval reads
//! `world.civilizations`, which no Rust world carries yet; civMult is
//! exactly 1 until the civilization port registers bonuses (the same
//! value every civ-less TS world takes).
use crate::core::{Eid, Sfc32, World as CoreWorld};
use serde::Deserialize;
use std::collections::{BTreeMap, HashSet};
use std::path::Path;

/// JS `Math.round`: half toward +∞.
pub fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

pub const FAMILY_UNASSIGNED: f64 = -1.0;
pub const POP_ORIGIN_ARRIVAL: f64 = 0.0;
pub const POP_ORIGIN_BIRTH: f64 = 1.0;
pub const NAME_LIST_SIZE: i64 = 2048;
const NAME_STREAM_DOMAIN: u32 = 0x6e61_6d65;
const TRAIT_STREAM_DOMAIN: u32 = 0x7472_6169;

pub const SKILL_SLUGS: [&str; 4] = ["construction", "gathering", "melee", "ranged"];
pub const SKILL_ENTRY_ARITY: usize = 5;
pub const LEGENDARY_TOTAL_XP: f64 = 18_000.0;
pub const MAX_SKILL_LEVEL: i64 = 15;
pub const WORK_RATE_PCT_PER_LEVEL: f64 = 6.0;
pub const GATHER_XP_PER_UNIT: f64 = 10.0;
pub const CONSTRUCTION_XP_PER_TICK: f64 = 1.0;

pub const NEED_MAX: f64 = 100.0;
const REST_WORK_FULL_LEVEL: f64 = 60.0;
const REST_WORK_FLOOR_MULT: f64 = 0.75;
const DEPRIVED_REST_LEVEL: f64 = 30.0;
const DEPRIVATION_WORK_MULT: f64 = 0.75;

// Body part codes: index into the ascending slug list is the code.
const BODY_PART_ARM_L: f64 = 0.0;
const BODY_PART_ARM_R: f64 = 1.0;
const BODY_PART_HEAD: f64 = 2.0;
const BODY_PART_LEG_L: f64 = 3.0;
const BODY_PART_LEG_R: f64 = 4.0;
const BODY_PART_TORSO: f64 = 5.0;
const PART_INJURY_CAPACITY: f64 = 100.0;
const IMPAIRMENT_MAX_PENALTY_PCT: f64 = 0.5;
const INJURY_STACK_STRIDE: usize = 3;

// Lifecycle default config (systems/lifecycle.ts).
const DAY_TICKS: f64 = 14_400.0;
const ADULT_AGE_DAYS: f64 = 1.0;
const ELDER_AGE_DAYS: f64 = 4.0;

#[derive(Clone, Copy)]
pub struct PopComps {
    pub identity: usize,
    pub traits: usize,
    pub skills: usize,
    pub needs: usize,
    pub lessons: usize,
    pub body: usize,
    pub owner: usize,
}

impl PopComps {
    pub fn from_world(world: &CoreWorld) -> PopComps {
        let id = |name: &str| world.registry.id_of(name).unwrap_or_else(|_| panic!("registry lacks {name}"));
        PopComps {
            identity: id("Identity"),
            traits: id("Traits"),
            skills: id("Skills"),
            needs: id("Needs"),
            lessons: id("Lessons"),
            body: id("Body"),
            owner: id("Owner"),
        }
    }
}

fn row(world: &CoreWorld, component: usize, eid: Eid) -> Option<&Vec<f64>> {
    world.rows_by_component.get(component).and_then(|r| r.get(&eid))
}
fn rows_mut(world: &mut CoreWorld, component: usize) -> &mut BTreeMap<Eid, Vec<f64>> {
    world.rows_by_component.get_mut(component).expect("registered component")
}
fn set_row(world: &mut CoreWorld, component: usize, eid: Eid, values: &[f64]) {
    world.set_values(component, eid, values).expect("registered component");
}

// ---- trait content --------------------------------------------------------------

#[derive(Clone, Debug, Deserialize)]
struct TraitDef {
    id: String,
    commonality: f64,
    #[serde(rename = "workSpeedMult")]
    work_speed_mult: Option<f64>,
    #[serde(rename = "xpGainMult")]
    xp_gain_mult: Option<f64>,
}

#[derive(Deserialize)]
struct TraitsFile {
    traits: Vec<TraitDef>,
    #[serde(rename = "conflictPairs")]
    conflict_pairs: Vec<(String, String)>,
}

pub struct TraitsData {
    slugs: Vec<String>, // ascending; code = index + 1
    defs: BTreeMap<String, TraitDef>,
    conflicts: BTreeMap<String, Vec<String>>,
}

impl TraitsData {
    pub fn load_from_file(path: &Path) -> Result<TraitsData, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
        let file: TraitsFile = serde_json::from_str(&text).map_err(|e| format!("parse traits.json: {e}"))?;
        let mut defs: BTreeMap<String, TraitDef> = BTreeMap::new();
        let mut errors: Vec<String> = Vec::new();
        for def in file.traits {
            if def.commonality <= 0.0 {
                errors.push(format!("trait {:?}: commonality must be positive", def.id));
                continue;
            }
            if defs.insert(def.id.clone(), def).is_some() {
                errors.push("duplicate trait id".into());
            }
        }
        let mut undirected: BTreeMap<String, HashSet<String>> = BTreeMap::new();
        for (a, b) in &file.conflict_pairs {
            if !defs.contains_key(a) || !defs.contains_key(b) {
                errors.push(format!("conflict pair references unknown trait {a:?}/{b:?}"));
            }
            if a == b {
                errors.push(format!("conflict pair is self-referential: {a:?}"));
                continue;
            }
            undirected.entry(a.clone()).or_default().insert(b.clone());
            undirected.entry(b.clone()).or_default().insert(a.clone());
        }
        if !errors.is_empty() {
            return Err(format!("trait content validation failed: {}", errors.join("; ")));
        }
        let conflicts = undirected
            .into_iter()
            .map(|(k, v)| {
                let mut sorted: Vec<String> = v.into_iter().collect();
                sorted.sort();
                (k, sorted)
            })
            .collect();
        let slugs: Vec<String> = defs.keys().cloned().collect(); // BTreeMap = ascending
        Ok(TraitsData { slugs, defs, conflicts })
    }

    pub fn load_repo_defaults() -> Result<TraitsData, String> {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/sim/data/traits.json");
        Self::load_from_file(&path)
    }

    pub fn code_of(&self, slug: &str) -> f64 {
        self.slugs
            .iter()
            .position(|s| s == slug)
            .map(|i| i as f64 + 1.0)
            .unwrap_or_else(|| panic!("unknown trait: {slug:?}"))
    }
    pub fn slug_of_code(&self, code: f64) -> &str {
        self.slugs
            .get((code as i64 - 1) as usize)
            .unwrap_or_else(|| panic!("unknown trait code: {code}"))
    }
    fn commonality(&self, slug: &str) -> f64 {
        self.defs.get(slug).unwrap_or_else(|| panic!("unknown trait: {slug:?}")).commonality
    }
    fn conflicts_of(&self, slug: &str) -> &[String] {
        self.conflicts.get(slug).map(|v| v.as_slice()).unwrap_or(&[])
    }
    pub fn work_speed_mult(&self, slugs: &[String]) -> f64 {
        let mut mult = 1.0;
        for slug in slugs {
            if let Some(m) = self.defs.get(slug).unwrap_or_else(|| panic!("unknown trait: {slug:?}")).work_speed_mult {
                mult *= m;
            }
        }
        mult
    }
    pub fn xp_gain_mult(&self, slugs: &[String]) -> f64 {
        let mut mult = 1.0;
        for slug in slugs {
            if let Some(m) = self.defs.get(slug).unwrap_or_else(|| panic!("unknown trait: {slug:?}")).xp_gain_mult {
                mult *= m;
            }
        }
        mult
    }

    /// 1–3 commonality-weighted conflict-free picks, slugs ascending.
    pub fn roll_trait_slugs(&self, prng: &mut Sfc32) -> Vec<String> {
        let target = 1 + (prng.next_float() * 3.0).floor() as usize;
        let mut chosen: Vec<String> = Vec::new();
        let mut excluded: HashSet<&str> = HashSet::new();
        for _ in 0..target {
            let mut total_weight = 0.0;
            for slug in &self.slugs {
                if !excluded.contains(slug.as_str()) {
                    total_weight += self.commonality(slug);
                }
            }
            if total_weight <= 0.0 {
                break;
            }
            let mut roll = prng.next_float() * total_weight;
            let mut picked: Option<String> = None;
            for slug in &self.slugs {
                if excluded.contains(slug.as_str()) {
                    continue;
                }
                roll -= self.commonality(slug);
                if roll < 0.0 {
                    picked = Some(slug.clone());
                    break;
                }
            }
            let Some(picked) = picked else { break };
            excluded.insert(self.defs.get(&picked).unwrap().id.as_str());
            for conflict in self.conflicts_of(&picked).to_vec() {
                excluded.insert(self.defs.get(&conflict).unwrap().id.as_str());
            }
            chosen.push(picked);
        }
        chosen.sort();
        chosen
    }
}

// ---- identity allocation ----------------------------------------------------------

/// Splitmix-style scramble of (seed, eid) into a u32 stream seed.
pub fn pop_stream_seed(seed: u32, eid: Eid) -> u32 {
    let mut z = seed ^ (eid as u32).wrapping_mul(0x9e37_79b9);
    if z == 0 {
        z = 1;
    }
    z = (z ^ (z >> 16)).wrapping_mul(0x21f0_aaad);
    z = (z ^ (z >> 15)).wrapping_mul(0x735a_2d97);
    z ^ (z >> 15)
}

fn allocate_name_index(world: &mut CoreWorld, eid: Eid) -> i64 {
    let start = (pop_stream_seed(world.seed, eid ^ NAME_STREAM_DOMAIN as Eid) % NAME_LIST_SIZE as u32) as i64;
    for probe in 0..NAME_LIST_SIZE {
        let idx = (start + probe) % NAME_LIST_SIZE;
        if world.used_name_indexes.insert(idx) {
            return idx;
        }
    }
    let overflow = world.used_name_indexes.len() as i64;
    world.used_name_indexes.insert(overflow);
    overflow
}

pub fn generate_pop_traits(traits: &TraitsData, seed: u32, eid: Eid) -> Vec<String> {
    let mut prng = Sfc32::new_seeded(pop_stream_seed(seed, eid) ^ TRAIT_STREAM_DOMAIN);
    traits.roll_trait_slugs(&mut prng)
}

/// Attach Identity + Traits rows (name index, birth tick, origin).
pub fn attach_pop_identity(world: &mut CoreWorld, comps: &PopComps, traits: &TraitsData, eid: Eid, origin_birth: bool) {
    let name_idx = allocate_name_index(world, eid);
    let origin = if origin_birth { POP_ORIGIN_BIRTH } else { POP_ORIGIN_ARRIVAL };
    set_row(world, comps.identity, eid, &[name_idx as f64, world.tick as f64, FAMILY_UNASSIGNED, origin]);
    let codes: Vec<f64> = generate_pop_traits(traits, world.seed, eid).iter().map(|s| traits.code_of(s)).collect();
    set_row(world, comps.traits, eid, &codes);
}

pub fn attach_pop_skills(world: &mut CoreWorld, comps: &PopComps, eid: Eid) {
    set_row(world, comps.skills, eid, &[0.0]);
}
pub fn attach_pop_needs(world: &mut CoreWorld, comps: &PopComps, eid: Eid) {
    set_row(world, comps.needs, eid, &[NEED_MAX, NEED_MAX, NEED_MAX]);
}
pub fn attach_lessons(world: &mut CoreWorld, comps: &PopComps, eid: Eid) {
    set_row(world, comps.lessons, eid, &[0.0, -1.0, 0.0]);
}
pub fn attach_body(world: &mut CoreWorld, comps: &PopComps, eid: Eid) {
    set_row(world, comps.body, eid, &[0.0]);
}

/// Morale row at attach: [0, 0, 0] (components/morale.ts).
pub fn attach_morale(world: &mut CoreWorld, morale_component: usize, eid: Eid) {
    world.set_values(morale_component, eid, &[0.0, 0.0, 0.0]).expect("registered component");
}

/// TS attachOwner: player zero stays rowless; others stamp [playerId].
pub fn attach_owner(world: &mut CoreWorld, comps: &PopComps, eid: Eid, player_id: f64) {
    assert!(player_id >= 0.0 && player_id.fract() == 0.0, "unit owner must be a non-negative integer");
    if player_id == 0.0 {
        return;
    }
    set_row(world, comps.owner, eid, &[player_id]);
}

pub fn owner_of_unit(world: &CoreWorld, comps: &PopComps, eid: Eid) -> f64 {
    row(world, comps.owner, eid).map(|r| r[0]).unwrap_or(0.0)
}

pub struct IdentityFields {
    pub name_idx: f64,
    pub birth_tick: f64,
    pub family_id: f64,
    pub origin: f64,
}

pub fn read_identity(world: &CoreWorld, comps: &PopComps, eid: Eid) -> Option<IdentityFields> {
    let r = row(world, comps.identity, eid)?;
    Some(IdentityFields {
        name_idx: r[0],
        birth_tick: r[1],
        family_id: r[2],
        origin: r.get(3).copied().unwrap_or(POP_ORIGIN_ARRIVAL),
    })
}

pub fn read_traits(world: &CoreWorld, comps: &PopComps, traits: &TraitsData, eid: Eid) -> Option<Vec<String>> {
    row(world, comps.traits, eid).map(|r| r.iter().map(|c| traits.slug_of_code(*c).to_string()).collect())
}

// ---- lifecycle read path -----------------------------------------------------------

fn adult_ticks() -> f64 {
    ADULT_AGE_DAYS * DAY_TICKS
}
fn elder_ticks() -> f64 {
    ELDER_AGE_DAYS * DAY_TICKS
}

pub fn effective_age(world: &CoreWorld, comps: &PopComps, eid: Eid) -> Option<f64> {
    let identity = read_identity(world, comps, eid)?;
    let elapsed = world.tick as f64 - identity.birth_tick;
    Some(if identity.origin == POP_ORIGIN_BIRTH { elapsed } else { elapsed + adult_ticks() })
}

/// True when `eid` is a named child (rowless units are never children).
pub fn is_child(world: &CoreWorld, comps: &PopComps, eid: Eid) -> bool {
    match effective_age(world, comps, eid) {
        Some(age) => age < adult_ticks(),
        None => false,
    }
}

pub fn is_elder(world: &CoreWorld, comps: &PopComps, eid: Eid) -> bool {
    match effective_age(world, comps, eid) {
        Some(age) => age >= elder_ticks(),
        None => false,
    }
}

// ---- skills read/award path ---------------------------------------------------------

pub fn skill_code(slug: &str) -> f64 {
    SKILL_SLUGS
        .iter()
        .position(|s| *s == slug)
        .map(|i| i as f64 + 1.0)
        .unwrap_or_else(|| panic!("unknown skill: {slug:?}"))
}

pub fn xp_to_reach_level(level: i64) -> f64 {
    assert!((0..=MAX_SKILL_LEVEL).contains(&level), "skill level out of range: {level}");
    (500 * level + 50 * level * (level - 1)) as f64
}

pub fn level_of_total_xp(total_xp: f64) -> i64 {
    let mut level = 0;
    while level < MAX_SKILL_LEVEL && xp_to_reach_level(level + 1) <= total_xp.min(LEGENDARY_TOTAL_XP) {
        level += 1;
    }
    level
}

fn find_entry_base(r: &[f64], code: f64) -> Option<usize> {
    let count = r[0] as usize;
    for i in 0..count {
        let base = 1 + i * SKILL_ENTRY_ARITY;
        if r[base] == code {
            return Some(base);
        }
        if r[base] > code {
            break;
        }
    }
    None
}

fn insert_entry(r: &mut Vec<f64>, slug: &str) -> usize {
    let code = skill_code(slug);
    let count = r[0] as usize;
    let mut insert_at = 1 + count * SKILL_ENTRY_ARITY;
    for i in 0..count {
        let base = 1 + i * SKILL_ENTRY_ARITY;
        if r[base] == code {
            return base;
        }
        if r[base] > code {
            insert_at = base;
            break;
        }
    }
    for (k, value) in [code, 0.0, 0.0, 0.0, 0.0].iter().enumerate() {
        r.insert(insert_at + k, *value);
    }
    r[0] = count as f64 + 1.0;
    insert_at
}

pub fn has_skills_row(world: &CoreWorld, comps: &PopComps, eid: Eid) -> bool {
    row(world, comps.skills, eid).is_some()
}

pub fn total_xp(world: &CoreWorld, comps: &PopComps, eid: Eid, slug: &str) -> Option<f64> {
    let r = row(world, comps.skills, eid)?;
    let base = find_entry_base(r, skill_code(slug))?;
    Some(r[base + 1] + r[base + 2])
}

pub fn skill_level(world: &CoreWorld, comps: &PopComps, eid: Eid, slug: &str) -> Option<i64> {
    if !has_skills_row(world, comps, eid) {
        return None;
    }
    Some(level_of_total_xp(total_xp(world, comps, eid, slug).unwrap_or(0.0)))
}

/// Award practice XP (trait-scaled, ≥1, Legendary-clamped). No-op rowless.
pub fn award_practice(world: &mut CoreWorld, comps: &PopComps, traits: &TraitsData, eid: Eid, slug: &str, amount: f64) {
    assert!(amount > 0.0 && amount.fract() == 0.0, "skill award must be a positive integer, got {amount}");
    if !has_skills_row(world, comps, eid) {
        return;
    }
    let slugs = read_traits(world, comps, traits, eid).unwrap_or_default();
    let gained = (js_round(amount * traits.xp_gain_mult(&slugs))).max(1.0);
    let tick = world.tick as f64;
    let r = rows_mut(world, comps.skills).get_mut(&eid).expect("skills row");
    let base = find_entry_base(r, skill_code(slug)).unwrap_or_else(|| insert_entry(r, slug));
    let knowledge_xp = r[base + 1];
    let practice_xp = r[base + 2];
    let headroom = LEGENDARY_TOTAL_XP - (knowledge_xp + practice_xp);
    r[base + 2] = practice_xp + gained.min(headroom.max(0.0));
    r[base + 4] = tick;
    r[base + 3] = 0.0;
}

pub fn work_trait_mult(world: &CoreWorld, comps: &PopComps, traits: &TraitsData, eid: Eid) -> f64 {
    let slugs = read_traits(world, comps, traits, eid).unwrap_or_default();
    traits.work_speed_mult(&slugs)
}

pub fn work_multiplier_for(level: i64, trait_mult: f64) -> f64 {
    ((100.0 + WORK_RATE_PCT_PER_LEVEL * level as f64) / 100.0) * trait_mult
}

pub fn builder_milli_per_tick_for(base_milli: f64, level: i64, trait_mult: f64) -> f64 {
    js_round(base_milli * work_multiplier_for(level, trait_mult))
}

// ---- needs/body multipliers -----------------------------------------------------------

pub fn rest_work_multiplier(world: &CoreWorld, comps: &PopComps, eid: Eid) -> f64 {
    let Some(r) = row(world, comps.needs, eid) else { return 1.0 };
    let rest = r[1].clamp(0.0, NEED_MAX);
    if rest >= REST_WORK_FULL_LEVEL {
        return 1.0;
    }
    let slope = (1.0 - REST_WORK_FLOOR_MULT) / REST_WORK_FULL_LEVEL;
    REST_WORK_FLOOR_MULT + slope * rest
}

pub fn deprivation_work_multiplier(world: &CoreWorld, comps: &PopComps, eid: Eid) -> f64 {
    let Some(r) = row(world, comps.needs, eid) else { return 1.0 };
    if r[1] < DEPRIVED_REST_LEVEL {
        DEPRIVATION_WORK_MULT
    } else {
        1.0
    }
}

fn group_multiplier(r: &[f64], parts: &[f64]) -> f64 {
    let count = r[0] as usize;
    let mut severity = 0.0;
    for i in 0..count {
        let base = 1 + i * INJURY_STACK_STRIDE;
        if parts.contains(&r[base]) {
            severity += r[base + 1];
        }
    }
    let fraction = severity / PART_INJURY_CAPACITY;
    1.0 - fraction.clamp(0.0, 1.0) * IMPAIRMENT_MAX_PENALTY_PCT
}

pub struct Impairment {
    pub speed_mult: f64,
    pub attack_mult: f64,
    pub work_mult: f64,
}

pub fn injury_impairment(world: &CoreWorld, comps: &PopComps, eid: Eid) -> Impairment {
    let Some(r) = row(world, comps.body, eid) else {
        return Impairment { speed_mult: 1.0, attack_mult: 1.0, work_mult: 1.0 };
    };
    let vital = group_multiplier(r, &[BODY_PART_HEAD, BODY_PART_TORSO]);
    let arms = group_multiplier(r, &[BODY_PART_ARM_L, BODY_PART_ARM_R]);
    Impairment {
        speed_mult: vital * group_multiplier(r, &[BODY_PART_LEG_L, BODY_PART_LEG_R]),
        attack_mult: vital * arms,
        work_mult: vital * arms,
    }
}

/// The one gather-interval resolver: skill × traits × rest × injury ×
/// deprivation (× civ 1 — see module note), integer-rounded, ≥ 1.
pub fn resolve_gather_interval(world: &CoreWorld, comps: &PopComps, traits: &TraitsData, eid: Eid, base_ticks: f64) -> f64 {
    let skill_mult = work_multiplier_for(
        skill_level(world, comps, eid, "gathering").unwrap_or(0),
        work_trait_mult(world, comps, traits, eid),
    );
    let denom = skill_mult
        * rest_work_multiplier(world, comps, eid)
        * injury_impairment(world, comps, eid).work_mult
        * deprivation_work_multiplier(world, comps, eid);
    js_round(base_ticks / denom).max(1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::movement::define_sim_components;

    #[test]
    fn traits_load_and_roll_deterministically() {
        let traits = TraitsData::load_repo_defaults().expect("traits");
        assert_eq!(traits.slugs.len(), 26);
        assert_eq!(traits.code_of("ambitious"), 1.0);
        let a = generate_pop_traits(&traits, 424242, 18);
        let b = generate_pop_traits(&traits, 424242, 18);
        assert_eq!(a, b);
        assert!((1..=3).contains(&a.len()));
        let mut sorted = a.clone();
        sorted.sort();
        assert_eq!(a, sorted, "slugs ascending");
        for x in &a {
            for y in &a {
                if x != y {
                    assert!(!traits.conflicts_of(x).contains(y), "conflict-free: {x}/{y}");
                }
            }
        }
    }

    #[test]
    fn fresh_pop_rows_and_multipliers() {
        let traits = TraitsData::load_repo_defaults().unwrap();
        let mut world = CoreWorld::new(424242);
        define_sim_components(&mut world);
        let comps = PopComps::from_world(&world);
        let eid = world.spawn();
        attach_pop_identity(&mut world, &comps, &traits, eid, false);
        attach_pop_skills(&mut world, &comps, eid);
        attach_pop_needs(&mut world, &comps, eid);
        attach_body(&mut world, &comps, eid);
        let id = read_identity(&world, &comps, eid).unwrap();
        assert_eq!(id.family_id, -1.0);
        assert_eq!(id.origin, 0.0);
        assert!(!is_child(&world, &comps, eid), "arrival pops are adults");
        assert_eq!(skill_level(&world, &comps, eid, "gathering"), Some(0));
        award_practice(&mut world, &comps, &traits, eid, "gathering", 10.0);
        assert!(total_xp(&world, &comps, eid, "gathering").unwrap() >= 1.0);
        // Fresh needs/body are neutral.
        assert_eq!(rest_work_multiplier(&world, &comps, eid), 1.0);
        assert_eq!(injury_impairment(&world, &comps, eid).work_mult, 1.0);
        // Name indexes never repeat.
        let eid2 = world.spawn();
        attach_pop_identity(&mut world, &comps, &traits, eid2, false);
        assert_ne!(read_identity(&world, &comps, eid2).unwrap().name_idx, id.name_idx);
    }
}
