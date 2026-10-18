"""根据 Internet Archive 元数据生成 tracks.json（只收录已核实存在 FLAC 文件的条目）。

用法：python tools/gen_tracks.py tracks.json
每条曲目只需写 archive 标识符和一个能唯一匹配 FLAC 文件名的关键词。
"""
import json
import sys
import urllib.parse
import urllib.request

PD = 'Public Domain Mark 1.0（待复核）'
CC0 = 'CC0 1.0'

# (id, archive 标识符, 文件名关键词, 曲名, 演奏/演唱, 作曲, 分类, 乐器, 国家, 年代, 流派, 授权)
ENTRIES = [
    ('chopin-valse-adieu-cortot-1934', 'ChopinValseDeLadieuN9Op.69N1EnLaBemolMajeur-AlfredCortot1934', '78rpm', "Valse de l'Adieu Op.69 No.1", 'Alfred Cortot', 'Frédéric Chopin', 'instrumental', '钢琴', '波兰', '1934', '古典', PD),
    ('kreisler-liebesfreud-deman-1922', 'deman-liebesfreud', 'Deman', 'Liebesfreud（爱之喜悦）', 'Rudolf Deman', 'Fritz Kreisler', 'instrumental', '小提琴', '奥地利', '1922', '古典', PD),
    ('braga-serenade-szemere-1920', 'serenadebraga', 'Serenade', 'Serenade', 'Magda Szemere', '（待核）', 'instrumental', '小提琴', '匈牙利', '1920', '古典', PD),
    ('mule-tyrolienne-1931', 'tyroliennesaxophon', 'Tyrolienne', 'Tyrolienne', 'Marcel Mule', '（待核）', 'instrumental', '萨克斯', '法国', '1931', '古典', PD),
    ('moeremans-carnival-venice-1904', 'CarnevalOfVenice', 'Carneval', 'Carnival of Venice', 'Jean Moeremans', '（待核）', 'instrumental', '萨克斯', '比利时', '1904', '古典', PD),
    ('deiro-danube-waves-1914', 'danube-waves', 'Danube', 'Danube Waves', 'Pietro Deiro', 'Ion Ivanovici', 'instrumental', '手风琴', '美国', '1914', '古典', CC0),
    ('beethoven-piano-concerto-5-schnabel-1932', 'historia-650-4-4', 'Side A', '钢琴协奏曲第五号「皇帝」Op.73 第一乐章', 'Artur Schnabel（指挥 Malcolm Sargent）', 'Ludwig van Beethoven', 'instrumental', '钢琴', '德国', '1932', '古典', PD),
    ('beethoven-piano-concerto-3-schnabel-1933', 'historia-650-4-3', 'Side A', '钢琴协奏曲第三号 Op.37 第一乐章', 'Artur Schnabel（指挥 Malcolm Sargent）', 'Ludwig van Beethoven', 'instrumental', '钢琴', '德国', '1933', '古典', PD),
    ('chopin-berceuse-op57-backhaus-1928', 'berceuseop.57', 'Berceuse', 'Berceuse Op.57', 'Wilhelm Backhaus', 'Frédéric Chopin', 'instrumental', '钢琴', '波兰', '1928', '古典', PD),
    ('liszt-liebestraume-hambourg-1916', '05580-hamboug-liebestraume', 'Hamboug', 'Liebesträume', 'Mark Hambourg', 'Franz Liszt', 'instrumental', '钢琴', '匈牙利', '1916', '古典', PD),
    ('liszt-gnomenreigen-godowsky-1916', 'a-5800-godowsky-gnomenreigen', 'Godowsky', 'Gnomenreigen（精灵之舞）', 'Leopold Godowsky', 'Franz Liszt', 'instrumental', '钢琴', '匈牙利', '1916', '古典', PD),
    ('mozart-piano-concerto-12-long-1939', '02-long-kv-414-1.-satz-2', '01 Long', '钢琴协奏曲第12号 K.414 第一乐章', 'Kathleen Long（Boyd Neel 管弦乐团）', 'Wolfgang Amadeus Mozart', 'instrumental', '钢琴', '奥地利', '1939', '古典', PD),
    ('chopin-polonaise-as-friedman-1927', 'ChopinAsDurPolonaise1', 'Polonaise 1', 'Polonaise As-Dur（片段，待核）', 'Ignaz Friedman', 'Frédéric Chopin', 'instrumental', '钢琴', '波兰', '1927', '古典', PD),
    ('mozart-piano-trio-5-berner-1929', 'TrioNr.5GDurMozart95289B', 'Trio', '钢琴三重奏第五号 G大调', 'Berner Trio', 'Wolfgang Amadeus Mozart', 'instrumental', '钢琴三重奏', '奥地利', '1929', '古典', PD),
    ('janssen-das-wirtshaus-1938', 'JanssenDasWirtshaus', 'Janssen', 'Das Wirtshaus', 'Herbert Janssen', '（待核）', 'vocal', None, '德国', '1938', '经典', PD),
    ('shepard-sweetheart-again', 'JeanShephardYoureCallingMeSweetheartAgain', 'Shephard', "You're Calling Me Sweetheart Again", 'Jean Shepard', '（待核）', 'vocal', None, '美国', '（待核）', '流行', PD),
    ('caruso-solenne-forza-1906', 'forza_del_destino_Scotti-Caruso', 'Victor-acoustic', "Solenne in quest'ora（《命运之力》）", 'Enrico Caruso / Antonio Scotti', 'Giuseppe Verdi', 'vocal', None, '意大利', '1906', '歌剧', PD),
    ('caruso-over-there-1918', 'overthere1918', 'overthere', 'Over There', 'Enrico Caruso', 'George M. Cohan', 'vocal', None, '意大利', '1918', '流行', '公版（待复核）'),
    ('caruso-campana-san-giusto-1919', 'la-campana-di-san-giusto', 'Campana', 'La Campana di San Giusto', 'Enrico Caruso', 'Colombino Arona', 'vocal', None, '意大利', '1919', '经典', CC0),
    ('ivogun-il-pensieroso-1925', 'ivogun-pensieroso', 'Pensieroso', 'Il Pensieroso', 'Maria Ivogün', 'George Frideric Handel', 'vocal', None, '匈牙利', '1925', '古典', PD),
    ('jadlowker-caro-mio-1927', 'Jadlowker66633CaroMio', 'Caro mio', 'Caro mio ben', 'Hermann Jadlowker', '（待核）', 'vocal', None, '拉脱维亚', '1927', '古典', PD),
    ('jadlowker-pur-dicesti-1927', 'JadlowkerPurDicesti419Bm', 'Pur dicesti', 'Pur dicesti', 'Hermann Jadlowker', 'Lotti', 'vocal', None, '拉脱维亚', '1927', '古典', PD),
    ('mccormack-sospiri-1913', 'ir-1011-mc-cormack-sospiri', 'Sospiri', 'Sospiri miei, andate ove vi mando', 'John McCormack', 'Bimboni', 'vocal', None, '爱尔兰', '1913', '古典', PD),
    ('gluck-angels-ever-bright-1917', 'AngelsEverBrightAndFair74559', 'Angels', 'Angels Ever Bright and Fair', 'Alma Gluck', 'George Frideric Handel', 'vocal', None, '美国', '1917', '古典', PD),
    ('hempel-weary-heart-1923', 'hempel-da-205-weary-heart', 'Weary', 'None But the Weary Heart', 'Frieda Hempel', 'Pyotr Ilyich Tchaikovsky', 'vocal', None, '德国', '1923', '古典', PD),
    ('strienz-onegin-1937', 'strienz-onegin', 'Onegin', "Ein jeder kennt die Lieb' auf Erden（《叶甫盖尼·奥涅金》）", 'Wilhelm Strienz', 'Pyotr Ilyich Tchaikovsky', 'vocal', None, '德国', '1937', '歌剧', PD),
    ('stuckgold-amarilli-1923', 'AmarilliMiaBella_201905', 'Amarilli', 'Amarilli mia bella', 'Grete Stückgold', '（待核）', 'vocal', None, '德国', '1923', '古典', PD),
    # --- 低噪声的现代录音（第 13 项为文件格式，缺省为 flac）---
    ('chopin-ballade-1-musopen', 'musopen-chopin-complete-works-flac', 'ballade no. 1 in g', 'Ballade No.1 in G minor, Op.23', 'Musopen 录音', 'Frédéric Chopin', 'instrumental', '钢琴', '波兰', '现代录音', '古典', CC0, 'flac'),
    ('chopin-ballade-2-musopen', 'musopen-chopin-complete-works-flac', 'ballade no. 2', 'Ballade No.2 in F major, Op.38', 'Musopen 录音', 'Frédéric Chopin', 'instrumental', '钢琴', '波兰', '现代录音', '古典', CC0, 'flac'),
    ('chopin-etude-waterfall-musopen', 'musopen-chopin-complete-works-flac', 'Waterfall', "Etude Op.10 No.1 'Waterfall'", 'Musopen 录音', 'Frédéric Chopin', 'instrumental', '钢琴', '波兰', '现代录音', '古典', CC0, 'flac'),
    ('chopin-etude-revolutionary-musopen', 'musopen-chopin-complete-works-flac', 'Revolutionary', "Etude Op.10 No.12 'Revolutionary'", 'Musopen 录音', 'Frédéric Chopin', 'instrumental', '钢琴', '波兰', '现代录音', '古典', CC0, 'flac'),
    ('chopin-etude-tristesse-musopen', 'musopen-chopin-complete-works-flac', 'Tristesse', "Etude Op.10 No.3 'Tristesse'", 'Musopen 录音', 'Frédéric Chopin', 'instrumental', '钢琴', '波兰', '现代录音', '古典', CC0, 'flac'),
    ('chopin-etude-arpeggio-musopen', 'musopen-chopin-complete-works-flac', 'Arpeggio', "Etude Op.10 No.11 'Arpeggio'", 'Musopen 录音', 'Frédéric Chopin', 'instrumental', '钢琴', '波兰', '现代录音', '古典', CC0, 'flac'),
    ('beethoven-pastoral-gilanyan-2009', 'karine-gilanyan-beethoven-piano-sonata-nr.-15-in-d-major-op.-28-pastoral', '01 Karine', '钢琴奏鸣曲第15号「田园」Op.28 第一乐章', 'Karine Gilanyan', 'Ludwig van Beethoven', 'instrumental', '钢琴', '德国', '2009', '古典', PD, 'mp3'),
    ('tchaikovsky-piano-concerto-1-2026', 'tchaikovsky-concerto-1stmvmt', '01 Tchaikovsky', '钢琴协奏曲第1号 Op.23 第一乐章', 'Pianist（待核）', 'Pyotr Ilyich Tchaikovsky', 'instrumental', '钢琴', '俄国', '2026', '古典', CC0, 'mp3'),
    # --- Musopen 现代录音（肖邦全集，CC0）---
    ('chopin-barcarolle-musopen', 'musopen-chopin-complete-works-flac', 'Barcarolle Op. 60', 'Barcarolle Op.60', 'Musopen 录音', 'Frédéric Chopin', 'instrumental', '钢琴', '波兰', '现代录音', '古典', CC0, 'flac'),
    ('chopin-fantaisie-impromptu-musopen', 'musopen-chopin-complete-works-flac', 'Fantaisie - Impromptu', 'Fantaisie-Impromptu Op.66', 'Musopen 录音', 'Frédéric Chopin', 'instrumental', '钢琴', '波兰', '现代录音', '古典', CC0, 'flac'),
    ('chopin-impromptu-1-musopen', 'musopen-chopin-complete-works-flac', 'Impromptu no. 1 in A flat', 'Impromptu No.1 in A-flat major, Op.29', 'Musopen 录音', 'Frédéric Chopin', 'instrumental', '钢琴', '波兰', '现代录音', '古典', CC0, 'flac'),
    ('chopin-berceuse-musopen', 'musopen-chopin-complete-works-flac', 'Berceuse in D-flat', 'Berceuse in D-flat major, Op.57', 'Musopen 录音', 'Frédéric Chopin', 'instrumental', '钢琴', '波兰', '现代录音', '古典', CC0, 'flac'),
    ('chopin-mazurka-op17-4-musopen', 'musopen-chopin-complete-works-flac', 'Mazurka in A minor, Op. 17 no. 4', 'Mazurka in A minor, Op.17 No.4', 'Musopen 录音', 'Frédéric Chopin', 'instrumental', '钢琴', '波兰', '现代录音', '古典', CC0, 'flac'),
    ('chopin-polonaise-brillante-musopen', 'musopen-chopin-complete-works-flac', 'Andante spianato', 'Andante spianato and Grande Polonaise Brillante, Op.22', 'Musopen 录音', 'Frédéric Chopin', 'instrumental', '钢琴', '波兰', '现代录音', '古典', CC0, 'flac'),
    # --- Musopen 管弦乐 / 室内乐合集（公版）---
    ('beethoven-eroica-1-musopen', 'MusopenCollectionAsFlac', 'EroicaOp.55-01', '第三交响曲「英雄」Op.55 第一乐章', 'Musopen 管弦乐团', 'Ludwig van Beethoven', 'instrumental', '管弦乐', '德国', '现代录音', '古典', PD, 'flac'),
    ('beethoven-egmont-musopen', 'MusopenCollectionAsFlac', 'EgmontOverture', '《埃格蒙特》序曲 Op.84', 'Musopen 管弦乐团', 'Ludwig van Beethoven', 'instrumental', '管弦乐', '德国', '现代录音', '古典', PD, 'flac'),
    ('brahms-symphony-1-musopen', 'MusopenCollectionAsFlac', 'SymphonyNo.1InCMinorOp.68-01', '第一交响曲 C小调 Op.68 第一乐章', 'Musopen 管弦乐团', 'Johannes Brahms', 'instrumental', '管弦乐', '德国', '现代录音', '古典', PD, 'flac'),
    ('brahms-symphony-4-musopen', 'MusopenCollectionAsFlac', 'SymphonyNo.4InEMinorOp.98-01', '第四交响曲 E小调 Op.98 第一乐章', 'Musopen 管弦乐团', 'Johannes Brahms', 'instrumental', '管弦乐', '德国', '现代录音', '古典', PD, 'flac'),
    ('mozart-magic-flute-overture-musopen', 'MusopenCollectionAsFlac', 'MagicFluteOverture', '《魔笛》序曲', 'Musopen 管弦乐团', 'Wolfgang Amadeus Mozart', 'instrumental', '管弦乐', '奥地利', '现代录音', '古典', PD, 'flac'),
    ('mendelssohn-hebrides-musopen', 'MusopenCollectionAsFlac', 'HebridesOverture', '《芬格尔的洞穴》序曲（赫布里底群岛）', 'Musopen 管弦乐团', 'Felix Mendelssohn', 'instrumental', '管弦乐', '德国', '现代录音', '古典', PD, 'flac'),
    ('mozart-string-quartet-421-musopen', 'MusopenCollectionAsFlac', 'K421-01', '弦乐四重奏 d小调 K.421 第一乐章', 'Musopen 弦乐四重奏', 'Wolfgang Amadeus Mozart', 'instrumental', '弦乐四重奏', '奥地利', '现代录音', '古典', PD, 'flac'),
    # --- 现代声乐录音（低噪声，MP3）---
    ('schubert-du-bist-die-ruh-parry-cruwys-2016', 'Episode46DuBistDieRuh', 'du bist die ruh', 'Du bist die Ruh', 'Robert Parry-Cruwys', 'Franz Schubert', 'vocal', None, '英国', '2016', '艺术歌曲', 'CC BY-ND 3.0', 'mp3'),
    ('schubert-erlkonig-parry-cruwys-2015', 'Episode15DerErlkonig', 'der erlkonig', 'Erlkönig（魔王）', 'Robert Parry-Cruwys', 'Franz Schubert', 'vocal', None, '英国', '2015', '艺术歌曲', 'CC BY-ND 3.0', 'mp3'),
    ('handel-praise-ye-the-lord-2014', 'PraiseYeTheLord_201408', 'praise ye', 'Praise Ye the Lord', 'Nkunzemnyama（待核）', '（待核）', 'vocal', None, '（待核）', '2014', '宗教', 'Public Domain Mark 1.0（待复核）', 'mp3'),
    ('malay-rasa-sayang-2015', 'RasaSayangft.L', 'RasaSayang', 'Rasa Sayang', 'zuddox', '马来民歌', 'vocal', None, '马来西亚', '2015', '民歌', CC0, 'mp3'),
]


def main(out_path):
    out = []
    for entry in ENTRIES:
        tid, ident, kw, title, artist, composer, cat, instr, country, era, genre, lic = entry[:12]
        ext = entry[12] if len(entry) > 12 else 'flac'
        meta = json.load(urllib.request.urlopen(f'https://archive.org/metadata/{ident}', timeout=60))
        flacs = [f['name'] for f in meta.get('files', []) if f['name'].lower().endswith('.' + ext)]
        hits = [n for n in flacs if kw.lower() in n.lower()]
        if not hits:
            sys.exit(f'没有匹配的 FLAC 文件: {tid} ({ident}, 关键词 {kw!r})')
        name = hits[0]
        url = f'https://archive.org/download/{ident}/' + urllib.parse.quote(name)
        out.append({
            'id': tid, 'title': title, 'artist': artist, 'composer': composer,
            'category': cat, 'instrument': instr, 'country': country, 'era': era, 'genre': genre,
            'lossless': ext == 'flac', 'format': 'FLAC' if ext == 'flac' else 'VBR MP3', 'license': lic,
            'source': f'https://archive.org/details/{ident}', 'url': url,
        })
    data = {'updated': '2026-10-18', 'tracks': out}
    with open(out_path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write('\n')
    inst = sum(1 for t in out if t['category'] == 'instrumental')
    print(f'写入 {len(out)} 首：乐器 {inst}，歌曲 {len(out) - inst}')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'tracks.json')
