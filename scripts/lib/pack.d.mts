export declare function packDirectory(
  root: string,
  archive: string,
  options: { files: string[] },
): { digest: string; size: number }

export declare function listArchive(archive: string): {
  name: string
  dir: boolean
  size: number
}[]
