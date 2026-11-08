//! Entity-definition registry (SPEC §3): Rust port of
//! `src/data/definitions.ts` + the loading discipline of
//! `src/data/load.ts`. Loads the same JSON files under
//! `src/data/definitions/{units,buildings,techs,recipes,victory,civs}/`;
//! stable u8 codes are assigned exactly as TS (canonical id lists first,
//! then ascending slug), so digest-visible rows carry identical codes.
//!
//! Validation scope in this slice: JSON parse + id presence/uniqueness
//! + kind field agreement. The full zod schema/cross-ref rounds are
//! TS-side CI concerns (fixtures freeze the content); unknown fields
//! are ignored on read.
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;

pub const RESOURCE_SLUGS: [&str; 7] = ["food", "wood", "gold", "stone", "iron", "coal", "clay"];
pub const COMMODITY_SLUGS: [&str; 6] = ["planks", "bricks", "tools", "weapons", "armor", "meals"];
pub const AGES: [&str; 4] = ["dark", "feudal", "castle", "imperial"];

pub fn age_rank(age: &str) -> i64 {
    match age {
        "feudal" => 2,
        "castle" => 3,
        "imperial" => 4,
        _ => 1,
    }
}

pub type Costs = BTreeMap<String, i64>;

#[derive(Clone, Debug, Deserialize)]
pub struct UnitDef {
    pub id: String,
    #[serde(default)]
    pub costs: Costs,
    #[serde(rename = "ageGate", default = "def_dark")]
    pub age_gate: String,
    #[serde(rename = "techPrereqs", default)]
    pub tech_prereqs: Vec<String>,
    #[serde(rename = "trainTime", default)]
    pub train_time: i64,
    #[serde(default)]
    pub hp: i64,
    #[serde(default)]
    pub speed: f64,
    #[serde(rename = "carryCapacity", default)]
    pub carry_capacity: i64,
    #[serde(default = "def_range")]
    pub range: f64,
    #[serde(rename = "sightRadius", default)]
    pub sight_radius: f64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Footprint {
    pub width: i64,
    pub height: i64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct TrainQueueEntry {
    #[serde(rename = "unitId")]
    pub unit_id: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct TrainQueue {
    pub capacity: i64,
    pub trainable: Vec<TrainQueueEntry>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct BuildingDef {
    pub id: String,
    #[serde(default)]
    pub costs: Costs,
    #[serde(rename = "ageGate", default = "def_dark")]
    pub age_gate: String,
    #[serde(rename = "techPrereqs", default)]
    pub tech_prereqs: Vec<String>,
    #[serde(rename = "buildTime", default)]
    pub build_time: i64,
    pub footprint: Footprint,
    #[serde(default)]
    pub hp: i64,
    #[serde(rename = "workSlots", default)]
    pub work_slots: i64,
    #[serde(rename = "dropoffFilters", default)]
    pub dropoff_filters: Vec<String>,
    #[serde(rename = "acceptsRoles", default)]
    pub accepts_roles: Vec<String>,
    #[serde(rename = "sightRadius", default)]
    pub sight_radius: f64,
    #[serde(rename = "populationCap", default)]
    pub population_cap: i64,
    #[serde(rename = "trainQueue")]
    pub train_queue: Option<TrainQueue>,
    #[serde(rename = "isGate", default)]
    pub is_gate: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RecipeIo {
    #[serde(rename = "defId")]
    pub def_id: String,
    pub qty: i64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RecipeDef {
    pub id: String,
    #[serde(rename = "buildingId")]
    pub building_id: String,
    pub inputs: Vec<RecipeIo>,
    pub output: RecipeIo,
    pub ticks: i64,
    #[serde(rename = "ageGate", default = "def_dark")]
    pub age_gate: String,
    #[serde(rename = "techGate")]
    pub tech_gate: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct TechEffect {
    pub target: String,
    pub stat: String,
    #[serde(default = "def_mult")]
    pub op: String,
    pub value: f64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct UnitUpgrade {
    #[serde(rename = "fromUnitId")]
    pub from_unit_id: String,
    #[serde(rename = "toUnitId")]
    pub to_unit_id: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct TechDef {
    pub id: String,
    #[serde(default)]
    pub costs: Costs,
    #[serde(rename = "ageGate", default = "def_dark")]
    pub age_gate: String,
    #[serde(rename = "techPrereqs", default)]
    pub tech_prereqs: Vec<String>,
    #[serde(rename = "researchTime", default)]
    pub research_time: i64,
    #[serde(default)]
    pub effects: Vec<TechEffect>,
    #[serde(rename = "ageAdvance")]
    pub age_advance: Option<i64>,
    #[serde(rename = "buildingId")]
    pub building_id: Option<String>,
    #[serde(rename = "unitUpgrade")]
    pub unit_upgrade: Option<UnitUpgrade>,
}

fn def_dark() -> String {
    "dark".to_string()
}
fn def_range() -> f64 {
    0.5
}
fn def_mult() -> String {
    "mult".to_string()
}

const CANONICAL_UNIT_IDS: [&str; 31] = [
    "archer", "knight", "man-at-arms", "militia", "monk", "scout-cavalry", "skirmisher",
    "villager", "arbalest", "battering-ram", "cannon-galleon", "cataphract", "cavalier",
    "fire-ship", "fishing-boat", "galleon", "galley", "huskarl", "light-cavalry", "longbowman",
    "longswordsman", "mangonel", "paladin", "throwing-axeman", "trade-cart", "transport-ship",
    "trebuchet", "trebuchet-packed", "two-handed-swordsman", "war-galley", "crossbowman",
];
const CANONICAL_BUILDING_IDS: [&str; 25] = [
    "archery-range", "barracks", "blacksmith", "brothel", "church", "farm", "forge",
    "grand-academy", "grand-monument", "house", "kiln", "kitchen", "lumber-camp", "mill",
    "mining-camp", "monastery", "monument", "sawpit", "school", "smithy", "stable", "tavern",
    "town-center", "watch-tower", "wonder",
];
const CANONICAL_TECH_IDS: [&str; 36] = [
    "castle-age", "double-bit-axe", "feudal-age", "forging", "hand-cart", "imperial-age",
    "scale-mail", "wheelbarrow", "anarchy", "blast-furnace", "bloodlines", "bodkin-arrow",
    "bow-saw", "bracer", "chain-barding", "chain-mail", "chivalry", "fletching", "greek-fire",
    "husbandry", "iron-casting", "plate-barding", "plate-mail", "scale-barding", "yeomen",
    "padded-archer-armor", "leather-archer-armor", "ring-archer-armor", "man-at-arms-upgrade",
    "longswordsman-upgrade", "two-handed-swordsman-upgrade", "crossbowman-upgrade",
    "arbalest-upgrade", "light-cavalry-upgrade", "cavalier-upgrade", "paladin-upgrade",
];

fn assign_canonical_codes(ids: &[String], canonical: &[&str]) -> BTreeMap<String, u32> {
    let mut codes = BTreeMap::new();
    let mut next = 1u32;
    for id in canonical {
        if ids.iter().any(|i| i == id) {
            codes.insert(id.to_string(), next);
            next += 1;
        }
    }
    let mut remaining: Vec<&String> = ids.iter().filter(|i| !codes.contains_key(i.as_str())).collect();
    remaining.sort();
    for id in remaining {
        codes.insert(id.clone(), next);
        next += 1;
    }
    codes
}

fn assign_slug_codes(ids: &[String]) -> BTreeMap<String, u32> {
    let mut sorted: Vec<&String> = ids.iter().collect();
    sorted.sort();
    sorted.iter().enumerate().map(|(i, id)| ((*id).clone(), i as u32 + 1)).collect()
}

pub struct Defs {
    pub units: BTreeMap<String, UnitDef>,
    pub buildings: BTreeMap<String, BuildingDef>,
    pub techs: BTreeMap<String, TechDef>,
    pub recipes: BTreeMap<String, RecipeDef>,
    unit_codes: BTreeMap<String, u32>,
    building_codes: BTreeMap<String, u32>,
    tech_codes: BTreeMap<String, u32>,
    recipe_codes: BTreeMap<String, u32>,
}

fn load_family<T: for<'de> Deserialize<'de>>(
    dir: &Path,
    family: &str,
    expect_kind: &str,
    id_of: impl Fn(&T) -> &str,
) -> Result<BTreeMap<String, T>, String> {
    let family_dir = dir.join(family);
    let mut out: BTreeMap<String, T> = BTreeMap::new();
    let mut files: Vec<_> = std::fs::read_dir(&family_dir)
        .map_err(|e| format!("read definitions dir {}: {e}", family_dir.display()))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
        .collect();
    files.sort();
    for path in files {
        let text = std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
        let value: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("parse {}: {e}", path.display()))?;
        let kind = value.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        if kind != expect_kind {
            return Err(format!("{}: kind {kind:?} != {expect_kind:?}", path.display()));
        }
        let def: T = serde_json::from_value(value).map_err(|e| format!("decode {}: {e}", path.display()))?;
        let id = id_of(&def).to_string();
        if out.insert(id.clone(), def).is_some() {
            return Err(format!("duplicate definition id {id:?} in {family}"));
        }
    }
    Ok(out)
}

impl Defs {
    pub fn load_from_dir(dir: &Path) -> Result<Defs, String> {
        let units = load_family::<UnitDef>(dir, "units", "unit", |d| &d.id)?;
        let buildings = load_family::<BuildingDef>(dir, "buildings", "building", |d| &d.id)?;
        let techs = load_family::<TechDef>(dir, "techs", "tech", |d| &d.id)?;
        let recipes = load_family::<RecipeDef>(dir, "recipes", "recipe", |d| &d.id)?;
        let unit_codes = assign_canonical_codes(&units.keys().cloned().collect::<Vec<_>>(), &CANONICAL_UNIT_IDS);
        let building_codes =
            assign_canonical_codes(&buildings.keys().cloned().collect::<Vec<_>>(), &CANONICAL_BUILDING_IDS);
        let tech_codes = assign_canonical_codes(&techs.keys().cloned().collect::<Vec<_>>(), &CANONICAL_TECH_IDS);
        let recipe_codes = assign_slug_codes(&recipes.keys().cloned().collect::<Vec<_>>());
        Ok(Defs { units, buildings, techs, recipes, unit_codes, building_codes, tech_codes, recipe_codes })
    }

    /// Repo-checkout default: `<repo>/src/data/definitions`.
    pub fn load_repo_defaults() -> Result<Defs, String> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/data/definitions");
        Self::load_from_dir(&dir)
    }

    pub fn unit(&self, id: &str) -> &UnitDef {
        self.units.get(id).unwrap_or_else(|| panic!("unknown unit definition: {id:?}"))
    }
    pub fn building(&self, id: &str) -> &BuildingDef {
        self.buildings.get(id).unwrap_or_else(|| panic!("unknown building definition: {id:?}"))
    }
    pub fn tech(&self, id: &str) -> &TechDef {
        self.techs.get(id).unwrap_or_else(|| panic!("unknown tech definition: {id:?}"))
    }
    pub fn recipe(&self, id: &str) -> &RecipeDef {
        self.recipes.get(id).unwrap_or_else(|| panic!("unknown recipe definition: {id:?}"))
    }
    pub fn unit_code(&self, id: &str) -> u32 {
        *self.unit_codes.get(id).unwrap_or_else(|| panic!("unknown unit definition: {id:?}"))
    }
    pub fn building_code(&self, id: &str) -> u32 {
        *self.building_codes.get(id).unwrap_or_else(|| panic!("unknown building definition: {id:?}"))
    }
    pub fn building_id_of_code(&self, code: u32) -> &str {
        self.building_codes
            .iter()
            .find(|(_, c)| **c == code)
            .map(|(id, _)| id.as_str())
            .unwrap_or_else(|| panic!("unknown building def code: {code}"))
    }
    pub fn unit_id_of_code(&self, code: u32) -> &str {
        self.unit_codes
            .iter()
            .find(|(_, c)| **c == code)
            .map(|(id, _)| id.as_str())
            .unwrap_or_else(|| panic!("unknown unit def code: {code}"))
    }
    pub fn tech_code(&self, id: &str) -> u32 {
        *self.tech_codes.get(id).unwrap_or_else(|| panic!("unknown tech definition: {id:?}"))
    }
    pub fn recipe_code(&self, id: &str) -> u32 {
        *self.recipe_codes.get(id).unwrap_or_else(|| panic!("unknown recipe definition: {id:?}"))
    }
    pub fn recipe_id_of_code(&self, code: u32) -> &str {
        self.recipe_codes
            .iter()
            .find(|(_, c)| **c == code)
            .map(|(id, _)| id.as_str())
            .unwrap_or_else(|| panic!("unknown recipe def code: {code}"))
    }
    pub fn recipes_for_building(&self, building_id: &str) -> Vec<&RecipeDef> {
        // BTreeMap iteration is ascending-id already.
        self.recipes.values().filter(|r| r.building_id == building_id).collect()
    }
    pub fn resource_code(slug: &str) -> Option<usize> {
        RESOURCE_SLUGS.iter().position(|s| *s == slug)
    }
    pub fn commodity_code(slug: &str) -> Option<usize> {
        COMMODITY_SLUGS.iter().position(|s| *s == slug)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_definitions_load_with_canonical_codes() {
        let defs = Defs::load_repo_defaults().expect("load defs");
        assert!(defs.units.len() >= 31, "units: {}", defs.units.len());
        assert!(defs.buildings.len() >= 25, "buildings: {}", defs.buildings.len());
        // Canonical codes preserve the TS assignments.
        assert_eq!(defs.unit_code("archer"), 1);
        assert_eq!(defs.unit_code("villager"), 8);
        assert_eq!(defs.building_code("archery-range"), 1);
        assert_eq!(defs.building_code("town-center"), 23);
        assert_eq!(defs.building_id_of_code(23), "town-center");
        let villager = defs.unit("villager");
        assert_eq!(villager.carry_capacity, 10);
        assert_eq!(villager.speed, 1.0);
        let tc = defs.building("town-center");
        assert_eq!((tc.footprint.width, tc.footprint.height), (3, 3));
        assert_eq!(tc.dropoff_filters, ["food", "wood", "gold", "stone"]);
        assert_eq!(tc.train_queue.as_ref().unwrap().trainable[0].unit_id, "villager");
        // Recipe codes ascending by slug; every recipe's building exists.
        for recipe in defs.recipes.values() {
            assert!(defs.buildings.contains_key(&recipe.building_id), "recipe {} building", recipe.id);
        }
        assert_eq!(Defs::resource_code("clay"), Some(6));
    }
}
