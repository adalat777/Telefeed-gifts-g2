// Put the voice lines at their moments into the film and save an .mp4 (no extra tools on the Mac needed).
//   swift mux.swift <film.mp4> <plan.json> <out.mp4>
import AVFoundation
let a = CommandLine.arguments
let film = AVURLAsset(url: URL(fileURLWithPath: a[1]))
let plan = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: a[2]))) as! [[String: Any]]
let comp = AVMutableComposition()
let sem = DispatchSemaphore(value: 0)
Task {
  let vt = try! await film.loadTracks(withMediaType: .video).first!
  let dur = try! await film.load(.duration)
  let cv = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!
  try! cv.insertTimeRange(CMTimeRange(start: .zero, duration: dur), of: vt, at: .zero)
  cv.preferredTransform = try! await vt.load(.preferredTransform)
  let ca = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
  for p in plan {
    let asset = AVURLAsset(url: URL(fileURLWithPath: p["file"] as! String))
    guard let at = try? await asset.loadTracks(withMediaType: .audio).first else { continue }
    let ad = try! await asset.load(.duration)
    let start = CMTime(value: CMTimeValue((p["start_ms"] as! NSNumber).intValue), timescale: 1000)
    let len = CMTimeMinimum(ad, CMTimeSubtract(dur, start))
    try? ca.insertTimeRange(CMTimeRange(start: .zero, duration: len), of: at, at: start)
  }
  let out = URL(fileURLWithPath: a[3]); try? FileManager.default.removeItem(at: out)
  let ex = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetHighestQuality)!
  ex.outputURL = out; ex.outputFileType = .mp4
  await ex.export()
  print(ex.status == .completed ? "готово: \(a[3])" : "ошибка: \(String(describing: ex.error))")
  sem.signal()
}
sem.wait()
