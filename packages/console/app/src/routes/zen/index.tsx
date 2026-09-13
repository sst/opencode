import "./index.css"
import { createAsync, query } from "@solidjs/router"
import { Title, Meta } from "@solidjs/meta"
import { For } from "solid-js"
//import { HttpHeader } from "@solidjs/start"
import zenLogoLight from "../../asset/zen-ornate-light.svg"
import zenLogoDark from "../../asset/zen-ornate-dark.svg"
import compareVideo from "../../asset/lander/opencode-comparison-min.mp4"
import compareVideoPoster from "../../asset/lander/opencode-comparison-poster.png"
import avatarDax from "../../asset/lander/avatar-dax.png"
import avatarJay from "../../asset/lander/avatar-jay.png"
import avatarFrank from "../../asset/lander/avatar-frank.png"
import avatarAdam from "../../asset/lander/avatar-adam.png"
import avatarDavid from "../../asset/lander/avatar-david.png"
import { EmailSignup } from "~/component/email-signup"
import { Faq } from "~/component/faq"
import { Legal } from "~/component/legal"
import { Footer } from "~/component/footer"
import { Header } from "~/component/header"
import { getLastSeenWorkspaceID } from "../workspace/common"
import { IconGemini, IconMiniMax, IconZai } from "~/component/icon"
import { useI18n } from "~/context/i18n"
import { useLanguage } from "~/context/language"
import { LocaleLinks } from "~/component/locale-links"

const checkLoggedIn = query(async () => {
  "use server"
  return await getLastSeenWorkspaceID().catch(() => {})
}, "checkLoggedIn.get")

export default function Home() {
  const loggedin = createAsync(() => checkLoggedIn())
  const i18n = useI18n()
  const language = useLanguage()
  return (
    <main data-page="zen">
      {/*<HttpHeader name="Cache-Control" value="public, max-age=1, s-maxage=3600, stale-while-revalidate=86400" />*/}
      <Title>{i18n.t("zen.title")}</Title>
      <LocaleLinks path="/zen" />
      <Meta property="og:image" content="/social-share-zen.png" />
      <Meta name="twitter:image" content="/social-share-zen.png" />
      <Meta name="opencode:auth" content={loggedin() ? "true" : "false"} />

      <div data-component="container">
        <Header zen hideGetStarted />

        <div data-component="content">
          <section data-component="hero">
            <div data-slot="hero-copy">
              <img data-slot="zen logo light" src={zenLogoLight} alt="" />
              <img data-slot="zen logo dark" src={zenLogoDark} alt="" />
              <h1>{i18n.t("zen.hero.title")}</h1>
              <p>{i18n.t("zen.hero.body")}</p>
              <div data-slot="model-logos">
                <div>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <mask
                      id="mask0_79_128586"
                      style="mask-type:luminance"
                      maskUnits="userSpaceOnUse"
                      x="1"
                      y="1"
                      width="22"
                      height="22"
                    >
                      <path d="M23 1.5H1V22.2952H23V1.5Z" fill="white" />
                    </mask>
                    <g mask="url(#mask0_79_128586)">
                      <path
                        d="M9.43799 9.06943V7.09387C9.43799 6.92749 9.50347 6.80267 9.65601 6.71959L13.8206 4.43211C14.3875 4.1202 15.0635 3.9747 15.7611 3.9747C18.3775 3.9747 20.0347 5.9087 20.0347 7.96734C20.0347 8.11288 20.0347 8.27926 20.0128 8.44564L15.6956 6.03335C15.434 5.88785 15.1723 5.88785 14.9107 6.03335L9.43799 9.06943ZM19.1624 16.7637V12.0431C19.1624 11.7519 19.0315 11.544 18.7699 11.3984L13.2972 8.36234L15.0851 7.3849C15.2377 7.30182 15.3686 7.30182 15.5212 7.3849L19.6858 9.67238C20.8851 10.3379 21.6917 11.7519 21.6917 13.1243C21.6917 14.7047 20.7106 16.1604 19.1624 16.7636V16.7637ZM8.15158 12.6047L6.36369 11.6066C6.21114 11.5235 6.14566 11.3986 6.14566 11.2323V6.65735C6.14566 4.43233 7.93355 2.7478 10.3538 2.7478C11.2697 2.7478 12.1199 3.039 12.8396 3.55886L8.54424 5.92959C8.28268 6.07508 8.15181 6.28303 8.15181 6.57427V12.6049L8.15158 12.6047ZM12 14.7258L9.43799 13.3533V10.4421L12 9.06965L14.5618 10.4421V13.3533L12 14.7258ZM13.6461 21.0476C12.7303 21.0476 11.8801 20.7564 11.1604 20.2366L15.4557 17.8658C15.7173 17.7203 15.8482 17.5124 15.8482 17.2211V11.1905L17.658 12.1886C17.8105 12.2717 17.876 12.3965 17.876 12.563V17.1379C17.876 19.3629 16.0662 21.0474 13.6461 21.0474V21.0476ZM8.47863 16.4103L4.314 14.1229C3.11471 13.4573 2.30808 12.0433 2.30808 10.6709C2.30808 9.06965 3.31106 7.6348 4.85903 7.03168V11.773C4.85903 12.0642 4.98995 12.2721 5.25151 12.4177L10.7025 15.4328L8.91464 16.4103C8.76209 16.4934 8.63117 16.4934 8.47863 16.4103ZM8.23892 19.8207C5.77508 19.8207 3.96533 18.0531 3.96533 15.8696C3.96533 15.7032 3.98719 15.5368 4.00886 15.3704L8.30418 17.7412C8.56574 17.8867 8.82752 17.8867 9.08909 17.7412L14.5618 14.726V16.7015C14.5618 16.8679 14.4964 16.9927 14.3438 17.0758L10.1792 19.3633C9.61225 19.6752 8.93631 19.8207 8.23869 19.8207H8.23892ZM13.6461 22.2952C16.2844 22.2952 18.4865 20.5069 18.9882 18.1362C21.4301 17.5331 23 15.3495 23 13.1245C23 11.6688 22.346 10.2548 21.1685 9.23581C21.2775 8.79908 21.343 8.36234 21.343 7.92582C21.343 4.95215 18.8137 2.72691 15.892 2.72691C15.3034 2.72691 14.7365 2.80999 14.1695 2.99726C13.1882 2.08223 11.8364 1.5 10.3538 1.5C7.71557 1.5 5.51352 3.28829 5.01185 5.65902C2.56987 6.26214 1 8.44564 1 10.6707C1 12.1264 1.65404 13.5404 2.83147 14.5594C2.72246 14.9961 2.65702 15.4328 2.65702 15.8694C2.65702 18.8431 5.1863 21.0683 8.108 21.0683C8.69661 21.0683 9.26354 20.9852 9.83046 20.7979C10.8115 21.713 12.1634 22.2952 13.6461 22.2952Z"
                        fill="currentColor"
                      />
                    </g>
                  </svg>
                </div>
                <div>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M13.7891 3.93164L20.2223 20.0677H23.7502L17.317 3.93164H13.7891Z" fill="currentColor" />
                    <path
                      d="M6.32538 13.6824L8.52662 8.01177L10.7279 13.6824H6.32538ZM6.68225 3.93164L0.25 20.0677H3.84652L5.16202 16.6791H11.8914L13.2067 20.0677H16.8033L10.371 3.93164H6.68225Z"
                      fill="currentColor"
                    />
                  </svg>
                </div>
                <div>
                  <IconGemini width="24" height="24" />
                </div>
                <div>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path
                      d="M9.16861 16.0529L17.2018 9.85156C17.5957 9.54755 18.1586 9.66612 18.3463 10.1384C19.3339 12.6288 18.8926 15.6217 16.9276 17.6766C14.9626 19.7314 12.2285 20.1821 9.72948 19.1557L6.9995 20.4775C10.9151 23.2763 15.6699 22.5841 18.6411 19.4749C20.9979 17.0103 21.7278 13.6508 21.0453 10.6214L21.0515 10.6278C20.0617 6.17736 21.2948 4.39847 23.8207 0.760904C23.8804 0.674655 23.9402 0.588405 24 0.5L20.6762 3.97585V3.96506L9.16658 16.0551"
                      fill="currentColor"
                    />
                    <path
                      d="M7.37742 16.7017C4.67579 14.0395 5.14158 9.91963 7.44676 7.54383C9.15135 5.78544 11.9442 5.06779 14.3821 6.12281L17.0005 4.87559C16.5288 4.52392 15.9242 4.14566 15.2305 3.87986C12.0948 2.54882 8.34069 3.21127 5.79171 5.8386C3.33985 8.36779 2.56881 12.2567 3.89286 15.5751C4.88192 18.0552 3.26056 19.8094 1.62731 21.5801C1.04853 22.2078 0.467774 22.8355 0 23.5L7.3754 16.7037"
                      fill="currentColor"
                    />
                  </svg>
                </div>
                <div>
                  <IconMiniMax width="24" height="24" />
                </div>
                <div>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path
                      d="M12.6241 11.346L20.3848 3.44816C20.5309 3.29931 20.4487 3 20.2601 3H16.0842C16.0388 3 15.9949 3.01897 15.9594 3.05541L7.59764 11.5629C7.46721 11.6944 7.27446 11.5771 7.27446 11.3666V3.25183C7.27446 3.11242 7.18515 3 7.07594 3H4.19843C4.08932 3 4 3.11242 4 3.25183V20.7482C4 20.8876 4.08932 21 4.19843 21H7.07594C7.18515 21 7.27446 20.8876 7.27446 20.7482V17.1834C7.27446 17.1073 7.30136 17.0344 7.34815 16.987L9.94075 14.3486C10.0031 14.2853 10.0895 14.2757 10.159 14.3232L17.0934 19.5573C18.2289 20.3412 19.4975 20.8226 20.786 20.9652C20.9008 20.9778 21 20.8606 21 20.7133V17.3559C21 17.2276 20.9249 17.1232 20.8243 17.1073C20.0659 16.9853 19.326 16.6845 18.6569 16.222L12.6538 11.764C12.5291 11.6785 12.5135 11.4584 12.6241 11.346Z"
                      fill="currentColor"
                    />
                  </svg>
                </div>
                <div>
                  <IconZai width="24" height="24" />
                </div>
                <div>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path
                      fill-rule="evenodd"
                      clip-rule="evenodd"
                      d="M12.6043 1.34016C12.9973 2.03016 13.3883 2.72215 13.7783 3.41514C13.7941 3.44286 13.8169 3.46589 13.8445 3.48187C13.8721 3.49786 13.9034 3.50624 13.9353 3.50614H19.4873C19.6612 3.50614 19.8092 3.61614 19.9332 3.83314L21.3872 6.40311C21.5772 6.74011 21.6272 6.88111 21.4112 7.24011C21.1512 7.6701 20.8982 8.1041 20.6512 8.54009L20.2842 9.19809C20.1782 9.39409 20.0612 9.47809 20.2442 9.71008L22.8962 14.347C23.0682 14.648 23.0072 14.841 22.8532 15.117C22.4162 15.902 21.9712 16.681 21.5182 17.457C21.3592 17.729 21.1662 17.832 20.8382 17.827C20.0612 17.811 19.2863 17.817 18.5113 17.843C18.4946 17.8439 18.4785 17.8489 18.4644 17.8576C18.4502 17.8664 18.4385 17.8785 18.4303 17.893C17.5361 19.4773 16.6344 21.0573 15.7253 22.633C15.5563 22.926 15.3453 22.996 15.0003 22.997C14.0033 23 12.9983 23.001 11.9833 22.999C11.8889 22.9987 11.7961 22.9735 11.7145 22.9259C11.6328 22.8783 11.5652 22.8101 11.5184 22.728L10.1834 20.405C10.1756 20.3898 10.1637 20.3771 10.149 20.3684C10.1343 20.3598 10.1174 20.3554 10.1004 20.356H4.98244C4.69744 20.386 4.42944 20.355 4.17745 20.264L2.57447 17.494C2.52706 17.412 2.50193 17.319 2.50158 17.2243C2.50123 17.1296 2.52567 17.0364 2.57247 16.954L3.77945 14.834C3.79665 14.8041 3.80569 14.7701 3.80569 14.7355C3.80569 14.701 3.79665 14.667 3.77945 14.637C3.15073 13.5485 2.52573 12.4579 1.90448 11.3651L1.11449 9.97008C0.954488 9.66008 0.941489 9.47409 1.20949 9.00509C1.67448 8.1921 2.13647 7.38011 2.59647 6.56911C2.72847 6.33512 2.90046 6.23512 3.18046 6.23412C4.04344 6.23048 4.90644 6.23015 5.76943 6.23312C5.79123 6.23295 5.81259 6.22704 5.83138 6.21597C5.85016 6.20491 5.8657 6.1891 5.87643 6.17012L8.68239 1.27516C8.72491 1.2007 8.78631 1.13875 8.86039 1.09556C8.93448 1.05238 9.01863 1.02948 9.10439 1.02917C9.62838 1.02817 10.1574 1.02917 10.6874 1.02317L11.7044 1.00017C12.0453 0.997165 12.4283 1.03217 12.6043 1.34016ZM9.17238 1.74316C9.16185 1.74315 9.15149 1.74592 9.14236 1.75119C9.13323 1.75645 9.12565 1.76403 9.12038 1.77316L6.25442 6.78811C6.24066 6.81174 6.22097 6.83137 6.19729 6.84505C6.17361 6.85873 6.14677 6.86599 6.11942 6.86611H3.25346C3.19746 6.86611 3.18346 6.89111 3.21246 6.94011L9.02239 17.096C9.04739 17.138 9.03539 17.158 8.98839 17.159L6.19342 17.174C6.15256 17.1727 6.11214 17.1828 6.07678 17.2033C6.04141 17.2238 6.01253 17.2539 5.99342 17.29L4.67344 19.6C4.62944 19.678 4.65244 19.718 4.74144 19.718L10.4574 19.726C10.5034 19.726 10.5374 19.746 10.5614 19.787L11.9643 22.241C12.0103 22.322 12.0563 22.323 12.1033 22.241L17.1093 13.481L17.8923 12.0991C17.897 12.0905 17.904 12.0834 17.9125 12.0785C17.9209 12.0735 17.9305 12.0709 17.9403 12.0709C17.9501 12.0709 17.9597 12.0735 17.9681 12.0785C17.9765 12.0834 17.9835 12.0905 17.9883 12.0991L19.4123 14.629C19.4229 14.648 19.4385 14.6637 19.4573 14.6746C19.4761 14.6855 19.4975 14.6912 19.5193 14.691L22.2822 14.671C22.2893 14.6711 22.2963 14.6693 22.3024 14.6658C22.3086 14.6623 22.3137 14.6572 22.3172 14.651C22.3206 14.6449 22.3224 14.638 22.3224 14.631C22.3224 14.624 22.3206 14.6172 22.3172 14.611L19.4173 9.52508C19.4068 9.50809 19.4013 9.48853 19.4013 9.46859C19.4013 9.44864 19.4068 9.42908 19.4173 9.41209L19.7102 8.90509L20.8302 6.92811C20.8542 6.88711 20.8422 6.86611 20.7952 6.86611H9.20038C9.14138 6.86611 9.12738 6.84011 9.15738 6.78911L10.5914 4.28413C10.6021 4.26706 10.6078 4.24731 10.6078 4.22714C10.6078 4.20697 10.6021 4.18721 10.5914 4.17014L9.22538 1.77416C9.22016 1.7647 9.21248 1.75682 9.20315 1.75137C9.19382 1.74591 9.18319 1.74307 9.17238 1.74316ZM15.4623 9.76308C15.5083 9.76308 15.5203 9.78308 15.4963 9.82308L14.6643 11.2881L12.0513 15.873C12.0464 15.8819 12.0392 15.8894 12.0304 15.8945C12.0216 15.8996 12.0115 15.9022 12.0013 15.902C11.9912 15.902 11.9813 15.8993 11.9725 15.8942C11.9637 15.8891 11.9564 15.8818 11.9513 15.873L8.49839 9.84108C8.47839 9.80708 8.48839 9.78908 8.52639 9.78708L8.74239 9.77508L15.4643 9.76308H15.4623Z"
                      fill="currentColor"
                    />
                  </svg>
                </div>
              </div>
              <a href="/auth">
                <span>{i18n.t("zen.cta.start")}</span>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path
                    d="M6.5 12L17 12M13 16.5L17.5 12L13 7.5"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="square"
                  />
                </svg>
              </a>
            </div>
            <div data-slot="pricing-copy">
              <p>
                <strong>{i18n.t("zen.pricing.title")}</strong> <span>{i18n.t("zen.pricing.fee")}</span>
              </p>
              <p>{i18n.t("zen.pricing.body")}</p>
            </div>
          </section>

          <section data-component="comparison">
            <video src={compareVideo} autoplay playsinline loop muted preload="auto" poster={compareVideoPoster}>
              {i18n.t("common.videoUnsupported")}
            </video>
          </section>

          <section data-component="problem">
            <div data-slot="section-title">
              <h3>{i18n.t("zen.problem.title")}</h3>
              <p>{i18n.t("zen.problem.body")}</p>
            </div>
            <p>{i18n.t("zen.problem.subtitle")}</p>
            <ul>
              <li>
                <span>[*]</span> {i18n.t("zen.problem.item1")}
              </li>
              <li>
                <span>[*]</span> {i18n.t("zen.problem.item2")}
              </li>
              <li>
                <span>[*]</span> {i18n.t("zen.problem.item3")}
              </li>
            </ul>
          </section>

          <section data-component="how">
            <div data-slot="section-title">
              <h3>{i18n.t("zen.how.title")}</h3>
              <p>{i18n.t("zen.how.body")}</p>
            </div>
            <ul>
              <li>
                <span>[1]</span>
                <div>
                  <strong>{i18n.t("zen.how.step1.title")}</strong> - {i18n.t("zen.how.step1.beforeLink")}{" "}
                  <a href={language.route("/docs/zen/#how-it-works")} title={i18n.t("zen.how.step1.link")}>
                    {i18n.t("zen.how.step1.link")}
                  </a>
                </div>
              </li>
              <li>
                <span>[2]</span>
                <div>
                  <strong>{i18n.t("zen.how.step2.title")}</strong> -{" "}
                  <a href={language.route("/docs/zen/#pricing")}>{i18n.t("zen.how.step2.link")}</a>{" "}
                  {i18n.t("zen.how.step2.afterLink")}
                </div>
              </li>
              <li>
                <span>[3]</span>
                <div>
                  <strong>{i18n.t("zen.how.step3.title")}</strong> - {i18n.t("zen.how.step3.body")}
                </div>
              </li>
            </ul>
          </section>

          <section data-component="privacy">
            <div data-slot="privacy-title">
              <h3>{i18n.t("zen.privacy.title")}</h3>
              <div>
                <span>[*]</span>
                <p>
                  {i18n.t("zen.privacy.beforeExceptions")}{" "}
                  <a href={language.route("/docs/zen/#privacy")}>{i18n.t("zen.privacy.exceptionsLink")}</a>.
                </p>
              </div>
            </div>
          </section>

          <section data-component="testimonials">
            {/*Dax*/}
            <a href="https://x.com/thdxr/status/1973531687629017227">
              <div data-slot="testimonial">
                <div data-slot="name">
                  <img src={avatarDax} alt="" />
                  <strong>Dax Raad</strong>
                  <span>ex-CEO, Terminal Products</span>
                </div>
                <div data-slot="quote">
                  <span>@OpenCode</span>
                  {" Zen has been life changing, it's truly a no-brainer."}
                </div>
              </div>
            </a>
            {/*Jay*/}
            <a href="https://x.com/jayair/status/1973530190870618456">
              <div data-slot="testimonial">
                <div data-slot="name">
                  <img src={avatarJay} alt="" />
                  <strong>Jay V</strong>
                  <span>ex-Founder, SEED, PM, Melt, Pop, Dapt, Cadmus, and ViewPoint</span>
                </div>
                <div data-slot="quote">
                  {"4 out of 5 people on our team love using "}
                  <span>@OpenCode</span>
                  {" Zen."}
                </div>
              </div>
            </a>
            {/*Adam*/}
            <a href="https://x.com/adamdotdev/status/1973732040718860563">
              <div data-slot="testimonial">
                <div data-slot="name">
                  <img src={avatarAdam} alt="" />
                  <strong>Adam Elmore</strong>
                  <span>ex-Hero, AWS</span>
                </div>
                <div data-slot="quote">
                  {"I can't recommend "}
                  <span>@OpenCode</span>
                  {" Zen enough. Seriously, it's really good."}
                </div>
              </div>
            </a>
            {/*David*/}
            <a href="https://x.com/iamdavidhill/status/1973530568773214622">
              <div data-slot="testimonial">
                <div data-slot="name">
                  <img src={avatarDavid} alt="" />
                  <strong>David Hill</strong>
                  <span>ex-Head of Design, Laravel</span>
                </div>
                <div data-slot="quote">
                  {"With "}
                  <span>@OpenCode</span>
                  {" Zen I know all the models are tested and perfect for coding agents."}
                </div>
              </div>
            </a>
            {/*Frank*/}
            <a href="https://x.com/fanjiewang/status/1973530092736487756">
              <div data-slot="testimonial">
                <div data-slot="name">
                  <img src={avatarFrank} alt="" />
                  <strong>Frank Wang</strong>
                  <span>ex-Intern, Nvidia (4 times)</span>
                </div>
                <div data-slot="quote">I wish I was still at Nvidia.</div>
              </div>
            </a>
          </section>

          <section data-component="faq">
            <div data-slot="section-title">
              <h3>{i18n.t("common.faq")}</h3>
            </div>
            <ul>
              <li>
                <Faq question={i18n.t("zen.faq.q1")}>{i18n.t("zen.faq.a1")}</Faq>
              </li>
              <li>
                <Faq question={i18n.t("zen.faq.q2")}>{i18n.t("zen.faq.a2")}</Faq>
              </li>
              <li>
                <Faq question={i18n.t("zen.faq.q3")}>{i18n.t("zen.faq.a3")}</Faq>
              </li>
              <li>
                <Faq question={i18n.t("zen.faq.q4")}>
                  {i18n.t("zen.faq.a4.p1.beforePricing")}{" "}
                  <a href={language.route("/docs/zen/#pricing")}>{i18n.t("zen.faq.a4.p1.pricingLink")}</a>{" "}
                  {i18n.t("zen.faq.a4.p1.afterPricing")} {i18n.t("zen.faq.a4.p2.beforeAccount")}{" "}
                  <a href="/auth">{i18n.t("zen.faq.a4.p2.accountLink")}</a>. {i18n.t("zen.faq.a4.p3")}
                </Faq>
              </li>
              <li>
                <Faq question={i18n.t("zen.faq.q5")}>
                  {i18n.t("zen.faq.a5.beforeExceptions")}{" "}
                  <a href={language.route("/docs/zen/#privacy")}>{i18n.t("zen.faq.a5.exceptionsLink")}</a>.
                </Faq>
              </li>
              <li>
                <Faq question={i18n.t("zen.faq.q6")}>{i18n.t("zen.faq.a6")}</Faq>
              </li>
              <li>
                <Faq question={i18n.t("zen.faq.q7")}>{i18n.t("zen.faq.a7")}</Faq>
              </li>
              <li>
                <Faq question={i18n.t("zen.faq.q8")}>{i18n.t("zen.faq.a8")}</Faq>
              </li>
              <li>
                <Faq question={i18n.t("zen.faq.q9")}>
                  <For each={i18n.t("zen.faq.a9").split(/(\{\{contact\}\})/g)}>
                    {(part) =>
                      part === "{{contact}}" ? <a href="mailto:help@anoma.ly">{i18n.t("common.contactUs")}</a> : part
                    }
                  </For>
                </Faq>
              </li>
            </ul>
          </section>

          <EmailSignup />

          <Footer />
        </div>
      </div>

      <Legal />
    </main>
  )
}
