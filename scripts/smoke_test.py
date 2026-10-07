"""Exercise the actual local HTTP API and its workers using synthetic inputs."""

import argparse
import io
import json
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--files", action="store_true", help="Also run real image and PDF OCR")
    args = parser.parse_args()

    def request(path, payload=None, body=None, content_type="application/json"):
        if payload is not None:
            body = json.dumps(payload).encode()
        req = Request(args.base_url + path, data=body,
                      headers={"Content-Type": content_type} if body is not None else {})
        try:
            with urlopen(req, timeout=180) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    code, health = request("/api/health/?load=1")
    assert code == 200 and health["text_analysis_ready"], health
    assert health["background_processing_ready"] and health["analytics_ready"], health
    code, baseline = request("/api/stats/")
    assert code == 200, baseline
    expected_count = baseline["total_scores"]
    for text, required_label in [
        ("I was diagnosed with diabetes.", "health_disclosure"),
        ("I used to hurt myself and I am working on recovery.", "self_harm_disclosure"),
        ("My email is alex@example.com.", "email"),
        ("What are the symptoms of diabetes?", None),
        ("This is a general educational discussion about gardening and weather. " * 80
         + "\nMy email is alex@example.com.", "email"),
    ]:
        code, result = request("/api/analyze/", {"text": text})
        assert code == 200 and result["analysis_complete"], result
        labels = {item["label"] for item in result["detections"]}
        if required_label:
            assert required_label in labels, result
        else:
            assert not labels, result
        for item in result["detections"]:
            assert set(item) == {"label", "confidence", "sensitivity_score"}, item
            assert 0 <= item["confidence"] <= 1 and 0 <= item["sensitivity_score"] <= 1
        assert result["status"] == "queued", result
        assert result["pathway_pushed"] == len(result["detections"]), result
        expected_count += len(result["detections"])
        for _ in range(40):
            processed_code, processed = request("/api/get_results/?session_id=" + result["session_id"])
            if processed_code == 200:
                break
            time.sleep(0.1)
        assert processed_code == 200 and processed["status"] == "done", processed
        print(f"PASS {required_label or 'educational negative'} → immediate detections + processed result")

    for payload, expected in [({"text": None}, 400), ({}, 400), ({"image_base64": "!invalid!"}, 400)]:
        code, _ = request("/api/analyze/", payload)
        assert code == expected, (code, payload)
    code, _ = request("/api/score/", {"label": "invalid", "score": 90})
    assert code == 400

    if args.files:
        from PIL import Image, ImageDraw, ImageFont
        from pathlib import Path

        font_path = Path("/System/Library/Fonts/Supplemental/Arial.ttf")
        font = ImageFont.truetype(str(font_path), 36) if font_path.exists() else ImageFont.load_default()
        image = Image.new("RGB", (1300, 200), "white")
        ImageDraw.Draw(image).text((30, 55), "I was diagnosed with diabetes. Email: alex@example.com", fill="black", font=font)
        for format_name, filename, mime in [("PNG", "sample.png", "image/png"), ("PDF", "sample.pdf", "application/pdf")]:
            buffer = io.BytesIO()
            image.save(buffer, format=format_name)
            boundary = "aegis-synthetic-smoke"
            body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"text\"\r\n\r\nPlease review this upload.\r\n"
                    f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{filename}\"\r\n"
                    f"Content-Type: {mime}\r\n\r\n").encode() + buffer.getvalue() + f"\r\n--{boundary}--\r\n".encode()
            code, result = request("/api/analyze/", body=body, content_type=f"multipart/form-data; boundary={boundary}")
            assert code == 200 and result["analysis_complete"], result
            assert "email" in {item["label"] for item in result["detections"]}, result
            assert result["pathway_pushed"] == len(result["detections"]), result
            expected_count += len(result["detections"])
            print(f"PASS {format_name} OCR combined with typed text")

    for _ in range(40):
        code, stats = request("/api/stats/")
        if code == 200 and stats["total_scores"] >= expected_count:
            break
        time.sleep(0.1)
    assert code == 200 and stats["total_scores"] >= expected_count, stats
    assert sum(stats["distribution"].values()) == stats["total_scores"], stats
    assert all(0 <= stats[key] <= 1 for key in ["current_average", "highest_score", "lowest_score"])
    print("PASS analytics: real counts, 0..1 sensitivity scale, matching distribution")
    print("Smoke test complete. Test events remain in local analytics.")


if __name__ == "__main__":
    main()
