// Pronunciations for common English words and song vocabulary, in ARPAbet
// (the CMU Pronouncing Dictionary's phoneme set, without stress marks).
// Words not listed here go through suffix stripping and letter-to-sound rules
// (g2p.js); this list mostly holds frequent words and the irregular ones the
// rules would get wrong.

const WORDS = `
a ah|about ah b aw t|above ah b ah v|across ah k r ao s|act ae k t|actually ae k ch uw ah l iy|add ae d|after ae f t er
again ah g eh n|against ah g eh n s t|age ey jh|ago ah g ow|ah aa|ahead ah hh eh d|ain't ey n t|air eh r|alive ah l ay v
all ao l|almost ao l m ow s t|alone ah l ow n|along ah l ao ng|already ao l r eh d iy|alright ao l r ay t|also ao l s ow
although ao l dh ow|always ao l w ey z|am ae m|among ah m ah ng|an ae n|and ae n d|angel ey n jh ah l|angels ey n jh ah l z
angry ae ng g r iy|animal ae n ah m ah l|another ah n ah dh er|answer ae n s er|any eh n iy|anybody eh n iy b aa d iy
anyone eh n iy w ah n|anything eh n iy th ih ng|anyway eh n iy w ey|anywhere eh n iy w eh r|are aa r|arm aa r m|arms aa r m z
around er aw n d|as ae z|ask ae s k|asleep ah s l iy p|at ae t|ate ey t|away ah w ey|awake ah w ey k|baby b ey b iy|back b ae k
bad b ae d|bag b ae g|ball b ao l|band b ae n d|bang b ae ng|be b iy|bear b eh r|beat b iy t|beautiful b y uw t ah f ah l
beauty b y uw t iy|became b ih k ey m|because b ih k ao z|become b ih k ah m|bed b eh d|been b ih n|before b ih f ao r
began b ih g ae n|begin b ih g ih n|behind b ih hh ay n d|being b iy ih ng|believe b ih l iy v|bell b eh l|below b ih l ow
beside b ih s ay d|best b eh s t|better b eh t er|between b ih t w iy n|beyond b ih y aa n d|big b ih g|bird b er d
birds b er d z|bit b ih t|black b l ae k|blame b l ey m|blind b l ay n d|blood b l ah d|blow b l ow|blue b l uw|body b aa d iy
bone b ow n|book b uh k|born b ao r n|both b ow th|bottle b aa t ah l|bottom b aa t ah m|bought b ao t|boy b oy|boys b oy z
brain b r ey n|brave b r ey v|bread b r eh d|break b r ey k|breath b r eh th|breathe b r iy dh|bridge b r ih jh|bright b r ay t
bring b r ih ng|broke b r ow k|broken b r ow k ah n|brother b r ah dh er|brought b r ao t|brown b r aw n|build b ih l d
built b ih l t|burn b er n|burning b er n ih ng|busy b ih z iy|but b ah t|butterfly b ah t er f l ay|buy b ay|by b ay|bye b ay|call k ao l|called k ao l d
calm k aa m|came k ey m|can k ae n|can't k ae n t|candle k ae n d ah l|car k aa r|care k eh r|carry k ae r iy|catch k ae ch
caught k ao t|cause k ah z|'cause k ah z|chance ch ae n s|change ch ey n jh|chase ch ey s|child ch ay l d|children ch ih l d r ah n
choir k w ay er|choose ch uw z|chorus k ao r ah s|christmas k r ih s m ah s|church ch er ch|city s ih t iy|clear k l ih r
climb k l ay m|close k l ow s|closer k l ow s er|cloud k l aw d|clouds k l aw d z|cold k ow l d|color k ah l er|colors k ah l er z
come k ah m|comes k ah m z|coming k ah m ih ng|could k uh d|couldn't k uh d ah n t|count k aw n t|country k ah n t r iy
couple k ah p ah l|course k ao r s|cover k ah v er|crazy k r ey z iy|cried k r ay d|cross k r ao s|crowd k r aw d
crown k r aw n|cry k r ay|crying k r ay ih ng|cut k ah t|dance d ae n s|dancing d ae n s ih ng|danger d ey n jh er|dark d aa r k
darkness d aa r k n ah s|darling d aa r l ih ng|daughter d ao t er|day d ey|days d ey z|dead d eh d|dear d ih r|death d eh th
deep d iy p|desire d ih z ay er|did d ih d|didn't d ih d ah n t|die d ay|died d ay d|different d ih f er ah n t|do d uw
does d ah z|doesn't d ah z ah n t|dog d ao g|doing d uw ih ng|done d ah n|don't d ow n t|door d ao r|double d ah b ah l
down d aw n|dream d r iy m|dreams d r iy m z|dress d r eh s|drink d r ih ng k|drive d r ay v|drop d r aa p|drown d r aw n
drum d r ah m|dry d r ay|during d uh r ih ng|dust d ah s t|each iy ch|ear ih r|early er l iy|earth er th|easy iy z iy
eat iy t|echo eh k ow|edge eh jh|eight ey t|either iy dh er|else eh l s|empty eh m p t iy|end eh n d|enemy eh n ah m iy
enough ih n ah f|even iy v ah n|evening iy v n ih ng|ever eh v er|every eh v r iy|everybody eh v r iy b aa d iy
everyone eh v r iy w ah n|everything eh v r iy th ih ng|everywhere eh v r iy w eh r|eye ay|eyes ay z|face f ey s|fade f ey d
fall f ao l|falling f ao l ih ng|family f ae m ah l iy|far f aa r|fast f ae s t|father f aa dh er|fear f ih r|feel f iy l
feeling f iy l ih ng|feels f iy l z|feet f iy t|fell f eh l|felt f eh l t|few f y uw|field f iy l d|fight f ay t|find f ay n d
fine f ay n|finger f ih ng g er|fire f ay er|first f er s t|five f ay v|flame f l ey m|floor f l ao r|flow f l ow
flower f l aw er|flowers f l aw er z|fly f l ay|flying f l ay ih ng|follow f aa l ow|food f uw d|fool f uw l|for f ao r
forever f er eh v er|forget f er g eh t|forgive f er g ih v|found f aw n d|four f ao r|free f r iy|freedom f r iy d ah m
friend f r eh n d|friends f r eh n d z|from f r ah m|front f r ah n t|full f uh l|fun f ah n|future f y uw ch er|game g ey m
gave g ey v|get g eh t|getting g eh t ih ng|ghost g ow s t|gift g ih f t|girl g er l|girls g er l z|give g ih v|given g ih v ah n
glad g l ae d|glass g l ae s|glory g l ao r iy|glove g l ah v|glow g l ow|go g ow|god g aa d|goes g ow z|going g ow ih ng
gold g ow l d|golden g ow l d ah n|gone g ao n|gonna g aa n ah|good g uh d|goodbye g uh d b ay|got g aa t|gotta g aa t ah
grace g r ey s|great g r ey t|green g r iy n|ground g r aw n d|grow g r ow|grown g r ow n|guess g eh s|guitar g ih t aa r
gun g ah n|guy g ay|had hh ae d|hair hh eh r|half hh ae f|hand hh ae n d|hands hh ae n d z|happy hh ae p iy|hard hh aa r d
has hh ae z|hate hh ey t|have hh ae v|haven't hh ae v ah n t|he hh iy|he's hh iy z|head hh eh d|hear hh ih r|heard hh er d
heart hh aa r t|hearts hh aa r t s|heat hh iy t|heaven hh eh v ah n|heavy hh eh v iy|height hh ay t|hell hh eh l
hello hh ah l ow|help hh eh l p|her hh er|here hh ih r|hey hh ey|hide hh ay d|high hh ay|higher hh ay er|hill hh ih l|him hh ih m
his hh ih z|history hh ih s t er iy|hit hh ih t|hmm hh m|hold hh ow l d|holding hh ow l d ih ng|hole hh ow l|home hh ow m
honest aa n ah s t|honey hh ah n iy|hope hh ow p|horse hh ao r s|hot hh aa t|hour aw er|hours aw er z|house hh aw s
how hh aw|however hh aw eh v er|huge hh y uw jh|human hh y uw m ah n|hundred hh ah n d r ah d|hungry hh ah ng g r iy
hurry hh er iy|hurt hh er t|i ay|i'd ay d|i'll ay l|i'm ay m|i've ay v|ice ay s|idea ay d iy ah|if ih f|in ih n|inside ih n s ay d
into ih n t uw|iron ay er n|is ih z|island ay l ah n d|isn't ih z ah n t|it ih t|it's ih t s|its ih t s|join jh oy n
journey jh er n iy|joy jh oy|jump jh ah m p|just jh ah s t|keep k iy p|key k iy|kid k ih d|kids k ih d z|kill k ih l
kind k ay n d|king k ih ng|kiss k ih s|knee n iy|knees n iy z|knew n uw|knife n ay f|knock n aa k|know n ow|knowing n ow ih ng
known n ow n|knows n ow z|la l aa|lady l ey d iy|laid l ey d|lake l ey k|land l ae n d|language l ae ng g w ah jh
last l ae s t|late l ey t|laugh l ae f|laughing l ae f ih ng|lay l ey|lead l iy d|learn l er n|least l iy s t|leave l iy v
left l eh f t|less l eh s|let l eh t|let's l eh t s|lie l ay|lies l ay z|life l ay f|light l ay t|lights l ay t s
like l ay k|line l ay n|lion l ay ah n|lips l ih p s|listen l ih s ah n|little l ih t ah l|live l ih v|lives l ih v z
living l ih v ih ng|lonely l ow n l iy|long l ao ng|longer l ao ng g er|look l uh k|looking l uh k ih ng|lose l uw z
lost l ao s t|lot l aa t|loud l aw d|love l ah v|loved l ah v d|lover l ah v er|loves l ah v z|loving l ah v ih ng|low l ow
lucky l ah k iy|lying l ay ih ng|made m ey d|magic m ae jh ih k|make m ey k|making m ey k ih ng|man m ae n|many m eh n iy
may m ey|maybe m ey b iy|me m iy|mean m iy n|meet m iy t|memory m eh m er iy|men m eh n|might m ay t|mile m ay l
miles m ay l z|million m ih l y ah n|mind m ay n d|mine m ay n|minute m ih n ah t|mirror m ih r er|miss m ih s|mmm m
moment m ow m ah n t|money m ah n iy|moon m uw n|more m ao r|morning m ao r n ih ng|most m ow s t|mother m ah dh er
mountain m aw n t ah n|mouth m aw th|move m uw v|moving m uw v ih ng|much m ah ch|music m y uw z ih k|must m ah s t|my m ay
myself m ay s eh l f|na n aa|name n ey m|nature n ey ch er|near n ih r|need n iy d|needs n iy d z|neither n iy dh er
never n eh v er|new n uw|news n uw z|next n eh k s t|nice n ay s|night n ay t|nights n ay t s|nine n ay n|no n ow
nobody n ow b aa d iy|none n ah n|nothing n ah th ih ng|now n aw|o ow|ocean ow sh ah n|of ah v|off ao f|often ao f ah n
oh ow|oil oy l|ok ow k ey|okay ow k ey|old ow l d|on aa n|once w ah n s|one w ah n|only ow n l iy|ooh uw|open ow p ah n
or ao r|other ah dh er|our aw er|out aw t|outside aw t s ay d|over ow v er|own ow n|page p ey jh|pain p ey n|paint p ey n t
paper p ey p er|paradise p ae r ah d ay s|part p aa r t|party p aa r t iy|pass p ae s|past p ae s t|people p iy p ah l
perfect p er f ih k t|person p er s ah n|phone f ow n|picture p ih k ch er|piece p iy s|place p l ey s|plan p l ae n
play p l ey|please p l iy z|poem p ow ah m|point p oy n t|poor p uh r|power p aw er|pray p r ey|pretty p r ih t iy
pride p r ay d|promise p r aa m ah s|proud p r aw d|prove p r uw v|pull p uh l|pure p y uh r|push p uh sh|put p uh t
queen k w iy n|question k w eh s ch ah n|quick k w ih k|quiet k w ay ah t|quite k w ay t|rain r ey n|raise r ey z
ran r ae n|reach r iy ch|read r iy d|ready r eh d iy|real r iy l|really r ih l iy|reason r iy z ah n|red r eh d
remember r ih m eh m b er|rest r eh s t|rhythm r ih dh ah m|rhyme r ay m|ride r ay d|right r ay t|ring r ih ng|rise r ay z
river r ih v er|road r ow d|rock r aa k|roll r ow l|room r uw m|rose r ow z|rough r ah f|round r aw n d|run r ah n
running r ah n ih ng|sad s ae d|safe s ey f|said s eh d|same s ey m|save s ey v|saw s ao|say s ey|saying s ey ih ng
says s eh z|scared s k eh r d|school s k uw l|sea s iy|search s er ch|second s eh k ah n d|secret s iy k r ah t|see s iy
seem s iy m|seems s iy m z|seen s iy n|send s eh n d|sense s eh n s|set s eh t|seven s eh v ah n|shadow sh ae d ow
shadows sh ae d ow z|shake sh ey k|shall sh ae l|she sh iy|she's sh iy z|shine sh ay n|shining sh ay n ih ng|ship sh ih p
shoe sh uw|shoes sh uw z|shot sh aa t|should sh uh d|shoulder sh ow l d er|shouldn't sh uh d ah n t|show sh ow|shut sh ah t
shy sh ay|sick s ih k|side s ay d|sight s ay t|sign s ay n|silence s ay l ah n s|silver s ih l v er|simple s ih m p ah l
since s ih n s|sing s ih ng|singer s ih ng er|singing s ih ng ih ng|sister s ih s t er|sit s ih t|six s ih k s|skin s k ih n
sky s k ay|sleep s l iy p|slow s l ow|slowly s l ow l iy|small s m ao l|smile s m ay l|smoke s m ow k|snow s n ow|so s ow
some s ah m|somebody s ah m b aa d iy|someday s ah m d ey|somehow s ah m hh aw|someone s ah m w ah n|something s ah m th ih ng
sometimes s ah m t ay m z|somewhere s ah m w eh r|son s ah n|song s ao ng|songs s ao ng z|soon s uw n|sorry s aa r iy
soul s ow l|sound s aw n d|south s aw th|space s p ey s|speak s p iy k|special s p eh sh ah l|spend s p eh n d|spirit s p ih r ah t
spring s p r ih ng|stand s t ae n d|star s t aa r|stars s t aa r z|start s t aa r t|stay s t ey|still s t ih l|stone s t ow n
stop s t aa p|storm s t ao r m|story s t ao r iy|straight s t r ey t|strange s t r ey n jh|stranger s t r ey n jh er
street s t r iy t|strong s t r ao ng|such s ah ch|sugar sh uh g er|summer s ah m er|sun s ah n|sunshine s ah n sh ay n
sure sh uh r|surprise s er p r ay z|sweet s w iy t|swim s w ih m|sword s ao r d|take t ey k|taken t ey k ah n|talk t ao k
talking t ao k ih ng|taste t ey s t|taught t ao t|tear t ih r|tears t ih r z|tell t eh l|ten t eh n|than dh ae n|thank th ae ng k
thanks th ae ng k s|that dh ae t|that's dh ae t s|the dh ah|their dh eh r|them dh eh m|then dh eh n|there dh eh r
there's dh eh r z|these dh iy z|they dh ey|they're dh eh r|thing th ih ng|things th ih ng z|think th ih ng k|this dh ih s
those dh ow z|though dh ow|thought th ao t|thousand th aw z ah n d|three th r iy|through th r uw|throw th r ow|thunder th ah n d er
till t ih l|time t ay m|times t ay m z|tired t ay er d|to t uw|today t ah d ey|together t ah g eh dh er|told t ow l d
tomorrow t ah m aa r ow|tonight t ah n ay t|too t uw|took t uh k|touch t ah ch|tough t ah f|toward t ah w ao r d|town t aw n
train t r ey n|tree t r iy|trees t r iy z|tried t r ay d|trouble t r ah b ah l|true t r uw|trust t r ah s t|truth t r uw th
try t r ay|trying t r ay ih ng|turn t er n|two t uw|under ah n d er|understand ah n d er s t ae n d|until ah n t ih l
up ah p|upon ah p aa n|us ah s|use y uw z|used y uw z d|very v eh r iy|view v y uw|voice v oy s|wait w ey t|waiting w ey t ih ng
wake w ey k|walk w ao k|walking w ao k ih ng|wall w ao l|walls w ao l z|wanna w aa n ah|want w aa n t|wanted w aa n t ih d
war w ao r|warm w ao r m|was w aa z|wasn't w aa z ah n t|watch w aa ch|water w ao t er|wave w ey v|waves w ey v z|way w ey
ways w ey z|we w iy|we'll w iy l|we're w ih r|wear w eh r|weather w eh dh er|week w iy k|weight w ey t|well w eh l|went w eh n t
were w er|what w ah t|what's w ah t s|whatever w ah t eh v er|when w eh n|where w eh r|whether w eh dh er|which w ih ch
while w ay l|whisper w ih s p er|white w ay t|who hh uw|whoa w ow|whole hh ow l|whose hh uw z|why w ay|wide w ay d|wife w ay f
wild w ay l d|will w ih l|win w ih n|wind w ih n d|window w ih n d ow|wine w ay n|wings w ih ng z|winter w ih n t er|wish w ih sh
with w ih dh|within w ih dh ih n|without w ih th aw t|woman w uh m ah n|women w ih m ah n|won w ah n|won't w ow n t
wonder w ah n d er|wonderful w ah n d er f ah l|word w er d|words w er d z|work w er k|world w er l d|worry w er iy|worse w er s
worst w er s t|worth w er th|would w uh d|wouldn't w uh d ah n t|write r ay t|wrong r ao ng|yeah y eh|year y ih r|years y ih r z
yes y eh s|yesterday y eh s t er d ey|yet y eh t|you y uw|you'll y uw l|you're y uh r|you've y uw v|young y ah ng|your y ao r
yours y ao r z|yourself y ao r s eh l f|youth y uw th|zero z ih r ow
`;

/** word -> phonemes ("hh ah l ow") */
export const LEXICON = new Map(
  WORDS.split(/[|\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const cut = s.indexOf(' ');
      return [s.slice(0, cut), s.slice(cut + 1)];
    }),
);
