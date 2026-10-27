"""从 docs/evidence 的原图生成文档用裁剪版（只裁空白边，不改内容）。

原图一律保留在 docs/evidence/，本脚本的产物落在 docs/deliverables/figures/，
build_intro.py 的 FIGURES() 优先取裁剪版。裁剪框写死在下面，改图后要重跑并目视复核。
"""

import os

from PIL import Image

EVIDENCE = "docs/evidence"
OUT = "docs/deliverables/figures"

# 文件名 -> 裁剪框 (left, top, right, bottom)；登录页卡片周围都是空白，裁掉才看得清
CROPS = {
    "01-login.png": (425, 15, 860, 435),
    # 批改面板：整页 1280×800 里真正要看的是表单选择行 + 提交行 + 批改卡，四周留白裁掉
    "08-graded.png": (208, 65, 1072, 700),
}


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    for name, box in CROPS.items():
        src = os.path.join(EVIDENCE, name)
        with Image.open(src) as im:
            before = im.size
            cropped = im.convert("RGB").crop(box)
            cropped.save(os.path.join(OUT, name))
            print(f"{name}: {before} -> {cropped.size} -> {OUT}/{name}")


if __name__ == "__main__":
    main()
