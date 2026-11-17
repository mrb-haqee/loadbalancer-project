/**
 * Strategi pemilihan backend.
 * Setiap strategi menerima daftar backend yang sedang dianggap sehat
 * dan mengembalikan satu entry (atau null bila daftar kosong).
 */

class RoundRobin {
  name = 'round-robin';
  #index = 0;

  pick(backends) {
    if (!backends.length) return null;
    const chosen = backends[this.#index % backends.length];
    this.#index = (this.#index + 1) % backends.length;
    return chosen;
  }
}

/**
 * Least connections: pilih backend dengan koneksi aktif paling sedikit.
 * Bila ada beberapa kandidat dengan jumlah sama, diputar dengan round robin
 * agar tidak selalu jatuh ke backend pertama di konfigurasi.
 */
class LeastConnections {
  name = 'least-connections';
  #cursor = 0;

  pick(backends) {
    if (!backends.length) return null;
    const fewest = Math.min(...backends.map((backend) => backend.activeConnections));
    const candidates = backends.filter((backend) => backend.activeConnections === fewest);
    const chosen = candidates[this.#cursor % candidates.length];
    this.#cursor = (this.#cursor + 1) % candidates.length;
    return chosen;
  }
}

export function createBalancer(algorithm) {
  switch (algorithm) {
    case 'round-robin':
      return new RoundRobin();
    case 'least-connections':
      return new LeastConnections();
    default:
      throw new Error(
        `Algoritma tidak dikenal: ${algorithm}. Pilihan: round-robin, least-connections`,
      );
  }
}
