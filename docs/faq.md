# FAQ

**Q: Does this work with DRM or encrypted streams?**  
A: No. The script does not decrypt or bypass DRM or encrypted content.

**Q: The saved file won't play.**  
A: Many HLS streams are transported as TS. The script concatenates bytes and labels them `.mp4`. Some players may not accept that. Remux externally if needed.

**Q: Why doesn't the overlay appear?**  
A: The site may not use HLS/DASH, may use Service Workers, or may block cross‑origin requests. Check the console for errors.
