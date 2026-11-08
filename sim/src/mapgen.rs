//! Tile-grid layers + seeded simplex mapgen (E3a, ticket #193): Rust
//! port of `src/sim/world/layers.ts`, `src/sim/mapgen/generate.ts`, and
//! the 2D path of the JS `simplex-noise` package v4.0.3 (MIT, Jonas
//! Wagner; permutation-table construction and the noise2D kernel are
//! ported op-for-op so map outcomes are bit-identical to TS).
//!
//! Canonical-order warning, inherited from the TS header: each noise's
//! permutation table consumes exactly 255 PRNG draws, so octave
//! construction order (4 terrain, then 3 elevation) is part of the
//! frozen contract — reordering changes every generated map.
use crate::core::{fnv1a64, format_digest, Sfc32};

pub const TERRAIN_DEEP_WATER: u8 = 0;
pub const TERRAIN_WATER: u8 = 1;
pub const TERRAIN_SHORE: u8 = 2;
pub const TERRAIN_GRASS: u8 = 3;
pub const TERRAIN_DIRT: u8 = 4;
pub const TERRAIN_FOREST_FLOOR: u8 = 5;
pub const TERRAIN_TYPE_COUNT: u8 = 6;
pub const MAX_ELEVATION_LEVEL: u8 = 8;
pub const PASSABLE: u8 = 1;
pub const IMPASSABLE: u8 = 0;
pub const DEFAULT_MAP_SIZE: usize = 120;

pub fn is_water_terrain(terrain: u8) -> bool {
    terrain == TERRAIN_DEEP_WATER || terrain == TERRAIN_WATER
}

#[derive(Clone, PartialEq, Debug)]
pub struct Layers {
    pub size: usize,
    pub terrain: Vec<u8>,
    pub elevation: Vec<u8>,
    pub passability: Vec<u8>,
}

fn validate_terrain(value: u8, index: usize) -> Result<(), String> {
    if value >= TERRAIN_TYPE_COUNT {
        return Err(format!("terrain byte {index} out of enum range: {value}"));
    }
    Ok(())
}

fn validate_elevation(value: u8, index: usize) -> Result<(), String> {
    if value > MAX_ELEVATION_LEVEL {
        return Err(format!("elevation byte {index} above level {MAX_ELEVATION_LEVEL}: {value}"));
    }
    Ok(())
}

pub fn derive_passability(terrain: &[u8]) -> Result<Vec<u8>, String> {
    let mut passability = vec![0u8; terrain.len()];
    for (i, &t) in terrain.iter().enumerate() {
        validate_terrain(t, i)?;
        passability[i] = if is_water_terrain(t) { IMPASSABLE } else { PASSABLE };
    }
    Ok(passability)
}

pub fn build_layers(terrain: Vec<u8>, elevation: Vec<u8>) -> Result<Layers, String> {
    if terrain.len() != elevation.len() {
        return Err(format!("layer length mismatch: terrain {} vs elevation {}", terrain.len(), elevation.len()));
    }
    let tile_count = terrain.len();
    let size = (tile_count as f64).sqrt() as usize;
    if size < 1 || size * size != tile_count {
        return Err(format!("grid size must be a positive integer, got {size}"));
    }
    for i in 0..tile_count {
        validate_terrain(terrain[i], i)?;
        validate_elevation(elevation[i], i)?;
    }
    let passability = derive_passability(&terrain)?;
    Ok(Layers { size, terrain, elevation, passability })
}

pub fn serialize_layers(layers: &Layers) -> Vec<u8> {
    let n = layers.size * layers.size;
    debug_assert_eq!(layers.terrain.len(), n);
    let mut bytes = vec![0u8; n * 3];
    bytes[..n].copy_from_slice(&layers.terrain);
    bytes[n..2 * n].copy_from_slice(&layers.elevation);
    bytes[2 * n..].copy_from_slice(&layers.passability);
    bytes
}

pub fn deserialize_layers(bytes: &[u8]) -> Result<Layers, String> {
    if bytes.is_empty() || bytes.len() % 3 != 0 {
        return Err(format!("map bytes must be a nonzero multiple of 3 (three planes), got {}", bytes.len()));
    }
    let tile_count = bytes.len() / 3;
    let size = (tile_count as f64).sqrt() as usize;
    if size * size != tile_count {
        return Err(format!("map bytes encode {tile_count} tiles, which is not a perfect square"));
    }
    let terrain = bytes[..tile_count].to_vec();
    let elevation = bytes[tile_count..2 * tile_count].to_vec();
    let stored_passability = bytes[2 * tile_count..].to_vec();
    for i in 0..tile_count {
        validate_terrain(terrain[i], i)?;
        validate_elevation(elevation[i], i)?;
    }
    let expected = derive_passability(&terrain)?;
    for i in 0..tile_count {
        if stored_passability[i] != expected[i] {
            return Err(format!(
                "passability plane inconsistent with terrain at tile {i}: stored {}, expected {}",
                stored_passability[i], expected[i]
            ));
        }
    }
    Ok(Layers { size, terrain, elevation, passability: stored_passability })
}

pub fn layers_hash(layers: &Layers) -> String {
    format_digest(fnv1a64(&serialize_layers(layers)))
}

// ---------------------------------------------------------------- simplex-noise 2D (JS v4.0.3 port)

const GRAD2: [f64; 24] = [
    1.0, 1.0, -1.0, 1.0, 1.0, -1.0, -1.0, -1.0, //
    1.0, 0.0, -1.0, 0.0, 1.0, 0.0, -1.0, 0.0, //
    0.0, 1.0, 0.0, -1.0, 0.0, 1.0, 0.0, -1.0,
];

fn build_permutation_table(prng: &mut Sfc32) -> [u8; 512] {
    let mut p = [0u8; 512];
    for i in 0..256 {
        p[i] = i as u8;
    }
    for i in 0..255usize {
        // ~~(random() * (256 - i)): trunc toward zero of a non-negative
        // product == floor.
        let r = i + (prng.next_float() * (256 - i) as f64) as usize;
        p.swap(i, r);
    }
    for i in 256..512 {
        p[i] = p[i - 256];
    }
    p
}

pub struct Noise2D {
    perm: [u8; 512],
    perm_grad_x: [f64; 512],
    perm_grad_y: [f64; 512],
}

impl Noise2D {
    pub fn new(prng: &mut Sfc32) -> Self {
        let perm = build_permutation_table(prng);
        let mut perm_grad_x = [0.0; 512];
        let mut perm_grad_y = [0.0; 512];
        for i in 0..512 {
            let v = perm[i] as usize;
            perm_grad_x[i] = GRAD2[(v % 12) * 2];
            perm_grad_y[i] = GRAD2[(v % 12) * 2 + 1];
        }
        Noise2D { perm, perm_grad_x, perm_grad_y }
    }

    pub fn noise(&self, x: f64, y: f64) -> f64 {
        let f2 = 0.5 * (3.0f64.sqrt() - 1.0);
        let g2 = (3.0 - 3.0f64.sqrt()) / 6.0;
        let mut n0 = 0.0;
        let mut n1 = 0.0;
        let mut n2 = 0.0;
        let s = (x + y) * f2;
        let i = (x + s).floor() as i32;
        let j = (y + s).floor() as i32;
        let t = (i + j) as f64 * g2;
        let x0 = x - (i as f64 - t);
        let y0 = y - (j as f64 - t);
        let (i1, j1): (i32, i32) = if x0 > y0 { (1, 0) } else { (0, 1) };
        let x1 = x0 - i1 as f64 + g2;
        let y1 = y0 - j1 as f64 + g2;
        let x2 = x0 - 1.0 + 2.0 * g2;
        let y2 = y0 - 1.0 + 2.0 * g2;
        let ii = (i & 255) as usize;
        let jj = (j & 255) as usize;
        let mut t0 = 0.5 - x0 * x0 - y0 * y0;
        if t0 >= 0.0 {
            let gi0 = ii + self.perm[jj] as usize;
            t0 *= t0;
            n0 = t0 * t0 * (self.perm_grad_x[gi0] * x0 + self.perm_grad_y[gi0] * y0);
        }
        let mut t1 = 0.5 - x1 * x1 - y1 * y1;
        if t1 >= 0.0 {
            let gi1 = ii + i1 as usize + self.perm[jj + j1 as usize] as usize;
            t1 *= t1;
            n1 = t1 * t1 * (self.perm_grad_x[gi1] * x1 + self.perm_grad_y[gi1] * y1);
        }
        let mut t2 = 0.5 - x2 * x2 - y2 * y2;
        if t2 >= 0.0 {
            let gi2 = ii + 1 + self.perm[jj + 1] as usize;
            t2 *= t2;
            n2 = t2 * t2 * (self.perm_grad_x[gi2] * x2 + self.perm_grad_y[gi2] * y2);
        }
        70.0 * (n0 + n1 + n2)
    }
}

// ---------------------------------------------------------------- generateMap

const TERRAIN_OCTAVES: usize = 4;
const ELEVATION_OCTAVES: usize = 3;

fn terrain_id_for(n: f64) -> u8 {
    if n < -0.62 {
        TERRAIN_DEEP_WATER
    } else if n < -0.28 {
        TERRAIN_WATER
    } else if n < -0.12 {
        TERRAIN_SHORE
    } else if n < 0.3 {
        TERRAIN_GRASS
    } else if n < 0.52 {
        TERRAIN_DIRT
    } else {
        TERRAIN_FOREST_FLOOR
    }
}

fn fbm(noises: &[Noise2D], x: f64, y: f64) -> f64 {
    let mut sum = 0.0;
    let mut amplitude = 1.0f64;
    let mut frequency = 1.0f64;
    let mut norm = 0.0;
    for noise in noises {
        sum += noise.noise(x * frequency, y * frequency) * amplitude;
        norm += amplitude;
        amplitude *= 0.5;
        frequency *= 2.0;
    }
    sum / norm
}

/// JS Math.round: halves round toward +infinity.
fn js_round(v: f64) -> i64 {
    (v + 0.5).floor() as i64
}

pub fn generate_map(seed: u32, size: usize) -> Result<Layers, String> {
    if size < 1 {
        return Err(format!("mapgen size must be a positive integer, got {size}"));
    }
    let mut prng = Sfc32::new_seeded(seed);
    // Canonical octave construction order: terrain ascending, then elevation.
    let terrain_noises: Vec<Noise2D> = (0..TERRAIN_OCTAVES).map(|_| Noise2D::new(&mut prng)).collect();
    let elevation_noises: Vec<Noise2D> = (0..ELEVATION_OCTAVES).map(|_| Noise2D::new(&mut prng)).collect();
    let tile_count = size * size;
    let mut terrain = vec![0u8; tile_count];
    let mut elevation = vec![0u8; tile_count];
    let center_offset = (size as f64 - 1.0) / 2.0;
    let terrain_freq = 1.0 / 18.0;
    let elevation_freq = 1.0 / 26.0;
    for y in 0..size {
        for x in 0..size {
            let index = y * size + x;
            let tx = (x as f64 - center_offset) * terrain_freq;
            let ty = (y as f64 - center_offset) * terrain_freq;
            terrain[index] = terrain_id_for(fbm(&terrain_noises, tx, ty));
            let ex = (x as f64 - center_offset) * elevation_freq;
            let ey = (y as f64 - center_offset) * elevation_freq;
            let level = js_round((fbm(&elevation_noises, ex, ey) + 1.0) * (MAX_ELEVATION_LEVEL as f64 / 2.0));
            elevation[index] = level.clamp(0, MAX_ELEVATION_LEVEL as i64) as u8;
        }
    }
    build_layers(terrain, elevation)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TERRAIN_ROWS: [&str; 32] = [
        "44334544332111112123333333333323",
        "44334543331111111233333333333323",
        "43444543332111111233333344333333",
        "34444443332211123333333454333333",
        "34444333222333233333344454433333",
        "44333332112233233333344444443333",
        "44332211111223233333333344433333",
        "34331111111222333333333333333333",
        "33321111011223333333333211222233",
        "33221111011133333333332211111223",
        "33222111112333333333333211121123",
        "33221111223333333332222211222233",
        "33333222333333323321111122222333",
        "44433333333433321211111112223334",
        "44444333344444332111111112223333",
        "44454433444434332211111121222333",
        "33444433444444433321112221211233",
        "33344333344454333321222223222233",
        "33344323334454333322222222223333",
        "23333223334433333333333332333333",
        "12333223333333333323332333333333",
        "12333323233333333232111223333433",
        "11232222233333443331111123333433",
        "11122223333333333331111122333333",
        "21233333333333344332111122233334",
        "22223333333333433322111222223344",
        "22233333333344433322112333333344",
        "22333333333444433322111233333444",
        "22233333333344433332221233333333",
        "22333333333334433333321333333333",
        "22333333332233333333322333333333",
        "21222332221112333333333333332333",
    ];

    /// m1t3 fixture: seed 424242, size 32 — hash, byte count, elevation
    /// histogram and full terrain grid must equal the TS snapshot.
    #[test]
    fn m1t3_mapgen_parity() {
        let layers = generate_map(424242, 32).unwrap();
        assert_eq!(layers_hash(&layers), "fnv1a64:8b9166f82317e334");
        let bytes = serialize_layers(&layers);
        assert_eq!(bytes.len(), 3072);
        let restored = deserialize_layers(&bytes).unwrap();
        assert_eq!(layers_hash(&restored), "fnv1a64:8b9166f82317e334");
        let mut histogram = [0u32; 9];
        for &e in &layers.elevation {
            histogram[e as usize] += 1;
        }
        assert_eq!(histogram, [0, 2, 81, 248, 441, 192, 60, 0, 0]);
        let rows: Vec<String> = layers
            .terrain
            .chunks(32)
            .map(|row| row.iter().map(|t| (b'0' + t) as char).collect())
            .collect();
        assert_eq!(rows, TERRAIN_ROWS.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    }

    #[test]
    fn mapgen_is_deterministic_and_seed_sensitive() {
        let a = generate_map(7, 24).unwrap();
        let b = generate_map(7, 24).unwrap();
        let c = generate_map(8, 24).unwrap();
        assert_eq!(layers_hash(&a), layers_hash(&b));
        assert_ne!(layers_hash(&a), layers_hash(&c));
    }

    #[test]
    fn deserialize_rejects_bad_bytes() {
        assert!(deserialize_layers(&[]).is_err());
        assert!(deserialize_layers(&[0u8; 5]).is_err(), "not multiple of 3 / non-square");
        assert!(deserialize_layers(&[9u8; 12]).is_err(), "terrain 9 out of enum range (size 2)");
        // Size-1 map with lying passability plane: terrain water must be impassable.
        assert!(deserialize_layers(&[TERRAIN_WATER, 0, PASSABLE]).is_err());
        assert!(deserialize_layers(&[TERRAIN_GRASS, 9, PASSABLE]).is_err(), "elevation 9 > 8");
        let ok = deserialize_layers(&[TERRAIN_GRASS, 3, PASSABLE]).unwrap();
        assert_eq!(ok.size, 1);
    }
}
