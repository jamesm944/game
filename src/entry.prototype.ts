// Throwaway look-development entry; ordinary game boot remains available.
if (
  import.meta.env.DEV &&
  new URLSearchParams(location.search).get("prototype") === "terrain"
) {
  import("./render/terrain-look.prototype");
} else {
  import("./main");
}
