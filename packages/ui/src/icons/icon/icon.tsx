import { onMount, type ComponentProps, splitProps } from "solid-js"
import { additionalIcons, additionalIconViewBox } from "./additional-icons"
import "./icon.css"

// Consumers center the SVG viewport, so each icon must center its artwork within its viewBox.
const icons = {
  lock: {
    viewBox: "0 0 16 16",
    body: `<rect x="3.5" y="7" width="9" height="7" rx="1" stroke="currentColor"/><path d="M5 7V5a3 3 0 0 1 6 0v2M8 10v1" stroke="currentColor" stroke-linecap="round"/>`,
  },
  globe: {
    viewBox: "0 0 16 16",
    body: `<circle cx="8" cy="8" r="6" stroke="currentColor"/><ellipse cx="8" cy="8" rx="2.5" ry="6" stroke="currentColor"/><path d="M2 8h12" stroke="currentColor"/>`,
  },
  flask: {
    viewBox: "0 0 16 16",
    body: `<path d="M5.5 2H10.5M6 2V6L2.5 12C2 13 2.5 14 3.5 14H12.5C13.5 14 14 13 13.5 12L10 6V2M4.25 9H11.75" stroke="currentColor" stroke-linecap="square" stroke-linejoin="round"/>`,
  },
  edit: {
    viewBox: "0 0 16 16",
    body: `<path d="M13.5556 8.21529V13.5556H2.44446L2.44446 2.44445H7.78474M6.00002 8.16216V10H7.83786L14 3.83784L12.1622 2L6.00002 8.16216Z" stroke="currentColor"/>`,
  },
  "folder-add-left": {
    viewBox: "0 0 16 16",
    body: `<path d="M7.5 13.3333H1.5V2H6.83333L8.83333 4H14.8333V6M10.1667 11.3333H15.5M12.8333 8.66667V14" stroke="currentColor" stroke-miterlimit="10" stroke-linecap="square"/>`,
  },
  folder: {
    viewBox: "0 0 16 16",
    body: `<path d="M1.33337 2V13.3333H14.6667V4H8.66671L6.66671 2H1.33337Z" stroke="currentColor" stroke-miterlimit="10" stroke-linecap="square"/>`,
  },
  branch: {
    viewBox: "0 0 16 16",
    body: `<path d="M5.118 5.686V10.314M5.118 5.686C5.97 5.686 6.661 4.995 6.661 4.143C6.661 3.291 5.97 2.6 5.118 2.6C4.266 2.6 3.575 3.291 3.575 4.143C3.575 4.995 4.266 5.686 5.118 5.686ZM5.118 10.314C4.266 10.314 3.575 11.005 3.575 11.857C3.575 12.709 4.266 13.4 5.118 13.4C5.97 13.4 6.661 12.709 6.661 11.857M5.118 10.314C5.97 10.314 6.661 11.005 6.661 11.857M10.882 5.686C11.734 5.686 12.425 4.995 12.425 4.143C12.425 3.291 11.734 2.6 10.882 2.6C10.03 2.6 9.339 3.291 9.339 4.143C9.339 4.995 10.03 5.686 10.882 5.686ZM10.882 5.686V9.457C10.882 10.783 9.807 11.857 8.482 11.857H6.661" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  "branch-out": {
    viewBox: "0 0 16 16",
    body: `<path d="M10.4225 3.35355L12.9024 5.83344L10.4225 8.31333" stroke="currentColor"/><path d="M1 12.2852H4.23042C4.89912 12.2852 5.52359 11.951 5.89452 11.3946L9.00783 6.72462C8.37877 6.16823 10.0032 5.83402 10.6719 5.83402H12.9024" stroke="currentColor"/><path d="M8.5 12.2852H14" stroke="currentColor" stroke-linejoin="round"/>`,
  },
  "grid-plus": {
    viewBox: "0 0 16 16",
    body: `<path d="M13.9948 11.668H9.32812M11.6641 9.33203V13.9987M6.66667 9.33203V13.9987H2V9.33203H6.66667ZM6.66667 2V6.66667H2V2H6.66667ZM13.9948 2V6.66667H9.32812V2H13.9948Z" stroke="currentColor" stroke-miterlimit="10" stroke-linecap="square"/>`,
  },
  help: {
    viewBox: "0 0 16 16",
    body: `<path d="M6.33345 6.33349V5.00015H9.66679V7.00015L8.00015 8.00015V9.66679M8.27485 11.6819H7.71897M14.4446 8.00011C14.4446 11.5593 11.5593 14.4446 8.00011 14.4446C4.44094 14.4446 1.55566 11.5593 1.55566 8.00011C1.55566 4.44094 4.44094 1.55566 8.00011 1.55566C11.5593 1.55566 14.4446 4.44094 14.4446 8.00011Z" stroke="currentColor" stroke-linecap="square"/>`,
  },
  info: {
    viewBox: "0 0 16 16",
    body: `<g transform="translate(2 2)"><path d="M12 12H0V0H12V12ZM1 1V11H11V1H1ZM6.5791 4.81641V9.37207H5.5791V5.81641H4.46777V4.81641H6.5791ZM6.85645 2.62891V3.62891H5.30078V2.62891H6.85645Z" fill="currentColor"/></g>`,
  },
  "circle-exclamation": {
    viewBox: "0 0 16 16",
    body: `<path d="M8.75 11.75H7.25V10.25H8.75V11.75Z" fill="currentColor"/><path d="M8.75 9.25H7.25V4.25H8.75V9.25Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M8 1C9.93286 1 11.684 1.7836 12.9502 3.0498C14.2164 4.31601 15 6.06714 15 8C15 11.866 11.866 15 8 15C6.06714 15 4.31601 14.2164 3.0498 12.9502C1.7836 11.684 1 9.93286 1 8C1 4.13401 4.13401 1 8 1ZM8 2C4.68629 2 2 4.68629 2 8C2 9.65699 2.67148 11.1559 3.75781 12.2422C4.84415 13.3285 6.34301 14 8 14C11.3137 14 14 11.3137 14 8C14 6.34301 13.3285 4.84415 12.2422 3.75781C11.1559 2.67148 9.65699 2 8 2Z" fill="currentColor"/>`,
  },
  "circle-xmark": {
    viewBox: "0 0 16 16",
    body: `<path fill-rule="evenodd" clip-rule="evenodd" d="M1.33334 8.00016C1.33334 4.31826 4.31811 1.3335 8.00001 1.3335C11.6819 1.3335 14.6667 4.31826 14.6667 8.00016C14.6667 11.6821 11.6819 14.6668 8.00001 14.6668C4.31811 14.6668 1.33334 11.6821 1.33334 8.00016ZM6.00001 5.29306L5.2929 6.00016L7.2929 8.00016L5.2929 10.0002L6.00001 10.7073L8.00001 8.70727L10 10.7073L10.7071 10.0002L8.70712 8.00016L10.7071 6.00016L10 5.29306L8.00001 7.29306L6.00001 5.29306Z" fill="currentColor"/>`,
  },
  "sidebar-right": {
    viewBox: "0 0 20 20",
    body: `<path d="M2.91536 2.91406H2.36536V2.36406H2.91536V2.91406ZM2.91536 17.0807V17.6307H2.36536V17.0807H2.91536ZM17.082 17.0807H17.632V17.6307H17.082V17.0807ZM17.082 2.91406V2.36406H17.632V2.91406H17.082ZM6.9987 2.91406H6.4487V2.36406H6.9987V2.91406ZM6.9987 17.0807V17.6307H6.4487V17.0807H6.9987ZM2.91536 2.91406H3.46536V17.0807H2.91536H2.36536V2.91406H2.91536ZM2.91536 17.0807V16.5307H17.082V17.0807V17.6307H2.91536V17.0807ZM17.082 17.0807H16.532V2.91406H17.082H17.632V17.0807H17.082ZM17.082 2.91406V3.46406H2.91536V2.91406V2.36406H17.082V2.91406ZM6.9987 2.91406H7.5487V17.0807H6.9987H6.4487V2.91406H6.9987ZM17.082 17.0807L17.082 17.6307L6.9987 17.6307V17.0807V16.5307L17.082 16.5307L17.082 17.0807ZM6.9987 2.91406V2.36406H17.082V2.91406V3.46406H6.9987V2.91406Z" fill="currentColor"/>`,
  },
  status: {
    viewBox: "0 0 20 20",
    body: `<path d="M2 10V18H18V10M2 10V2H18V10M2 10H18M5 6H9M5 14H9" stroke="currentColor"/>`,
  },
  "status-active": {
    viewBox: "0 0 20 20",
    body: `<path d="M18 2H2V10H18V2Z" fill="currentColor" fill-opacity="0.1"/><path d="M2 18H18V10H2V18Z" fill="currentColor" fill-opacity="0.1"/><path d="M2 10V18H18V10M2 10V2H18V10M2 10H18M5 6H9M5 14H9" stroke="currentColor"/>`,
  },
  "magnifying-glass": {
    viewBox: "0 0 16 16",
    body: `<path d="M14 14L10.3454 10.3454M6.88889 11.7778C9.58889 11.7778 11.7778 9.58889 11.7778 6.88889C11.7778 4.18889 9.58889 2 6.88889 2C4.18889 2 2 4.18889 2 6.88889C2 9.58889 4.18889 11.7778 6.88889 11.7778Z" stroke="currentColor"/>`,
  },
  menu: {
    viewBox: "0 0 16 16",
    body: `<path d="M2 8H14M2 4.664H14M2 11.336H14" stroke="currentColor"/>`,
  },
  plus: {
    viewBox: "0 0 16 16",
    body: `<path d="M8 2.88867V13.1109" stroke="currentColor" stroke-linejoin="round"/><path d="M2.88867 8H13.1109" stroke="currentColor" stroke-linejoin="round"/>`,
  },
  "settings-gear": {
    viewBox: "0 0 16 16",
    body: `<path d="M7.99998 1.3335L14 4.66683V11.3335L7.99998 14.6668L2 11.3335V4.66683L7.99998 1.3335Z" stroke="currentColor"/><path d="M9.99998 8.00016C9.99998 9.10476 9.10458 10.0002 7.99998 10.0002C6.89538 10.0002 5.99998 9.10476 5.99998 8.00016C5.99998 6.89556 6.89538 6.00016 7.99998 6.00016C9.10458 6.00016 9.99998 6.89556 9.99998 8.00016Z" stroke="currentColor"/>`,
  },
  "chevron-down": {
    viewBox: "0 0 16 16",
    body: `<path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor"/>`,
  },
  collapse: {
    viewBox: "0 0 16 16",
    body: `<path d="M8 1V6M11 3L8 6L5 3" stroke="currentColor"/><path d="M8 15V10M11 13L8 10L5 13" stroke="currentColor"/><path d="M4 8H6" stroke="currentColor"/><path d="M7 8H9" stroke="currentColor"/><path d="M10 8H12" stroke="currentColor"/>`,
  },
  check: {
    viewBox: "0 0 16 16",
    body: `<path d="M3.53613 8.17857L6.39328 11.75L12.4647 4.25" stroke="currentColor"/>`,
  },
  monitor: {
    viewBox: "0 0 16 16",
    body: `<path d="M4.05559 9.38889H0.500007C0.500007 9.38889 0.500017 8.59298 0.500017 7.61112V2.27778C0.500017 1.29594 0.500102 0.5 0.500102 0.5H13.3889C13.3889 0.5 13.3889 1.29594 13.3889 2.27778V7.61112C13.3889 8.59298 13.3889 9.38889 13.3889 9.38889H9.83336M4.05559 9.38889V11.6111H6.94448H9.83336V9.38889M4.05559 9.38889H9.83336" transform="translate(1.05556 1.94444)" stroke="currentColor"/>`,
  },
  "workspace-new": {
    viewBox: "0 0 16 16",
    body: `<path d="M2 10.7578V14.0011H5.24324M13.9991 5.24324V2H10.7559M13.9991 10.7578V14.0011H10.7559M2 5.24324V2H5.24324" stroke="currentColor" stroke-miterlimit="10" stroke-linecap="square"/><path d="M8 4.5V11.5M4.5 8H11.5" stroke="currentColor" stroke-linejoin="round"/>`,
  },
  "workspace-isolated": {
    viewBox: "0 0 16 16",
    body: `<path d="M10.5 10.5V5.5H5.5V10.5H10.5Z" fill="currentColor"/><rect x="2.5" y="2.5" width="11" height="11" stroke="currentColor"/>`,
  },
  workspace: {
    viewBox: "0 0 16 16",
    body: `<path d="M2 10.668V14.0013H10.6667M13.9974 10.6667V2H2.66406M13.9974 10.668V14.0013H10.6641M2 10V2H5.33333" stroke="currentColor" stroke-miterlimit="10" stroke-linecap="square"/><path d="M10.6693 10.6654V5.33203H5.33594V10.6654H10.6693Z" fill="currentColor"/>`,
  },
  "outline-worktree": {
    viewBox: "0 0 16 16",
    body: `<path d="M12 3.11133L14.3885 5.49977L12 7.88822M14.5 5.49972H10.058L5.13456 11.8139M14.5 11.6606L8.5 11.6606M5.50012 11.6597H1.5" stroke="currentColor"/>`,
  },
  "outline-trash": {
    viewBox: "0 0 16 16",
    body: `<path d="M2.44434 4.22224H13.5554M5.99994 4.22224V2.44446C5.99994 1.95557 5.99992 1.55557 5.99992 1.55557H9.99989C9.99989 1.55557 9.99994 1.95557 9.99994 2.44446V4.22224M6.55545 7.77779L6.7485 11.7778M9.44437 7.77779L9.2513 11.7778M12.1756 6.88891L11.8666 12.7556C11.8168 13.7068 11.7748 14.4445 11.7748 14.4445H4.22511C4.22511 14.4445 4.18392 13.7067 4.13414 12.7556L3.82509 6.88891" stroke="currentColor"/>`,
  },
  close: {
    viewBox: "0 0 20 20",
    body: `<path d="M14.4446 5.55566L5.55566 14.4446M5.55566 5.55566L14.4446 14.4446" stroke="currentColor" stroke-linejoin="round"/>`,
  },
  "xmark-small": {
    viewBox: "0 0 16 16",
    body: `<path d="M4.25 11.75L11.75 4.25M11.75 11.75L4.25 4.25" stroke="currentColor"/>`,
  },
  "outline-xmark": {
    viewBox: "0 0 16 16",
    body: `<path fill-rule="evenodd" clip-rule="evenodd" d="M4.99487 5.70186L7.29297 7.99995L4.99487 10.2981L5.70198 11.0052L8.00008 8.70706L10.2982 11.0052L11.0053 10.2981L8.70718 7.99995L11.0053 5.70186L10.2982 4.99475L8.00008 7.29285L5.70198 4.99475L4.99487 5.70186Z" fill="currentColor"/>`,
  },
  "outline-chevron-down": {
    viewBox: "0 0 16 16",
    body: `<path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor"/>`,
  },
  "outline-dots": {
    viewBox: "0 0 16 16",
    body: `<path d="M2.5 7.5H3.5V8.5H2.5V7.5Z" stroke="currentColor"/><path d="M7.5 7.5H8.5V8.5H7.5V7.5Z" stroke="currentColor"/><path d="M12.5 7.5H13.5V8.5H12.5V7.5Z" stroke="currentColor"/>`,
  },
  expand: {
    viewBox: "0 0 16 16",
    body: `<path d="M8.25 6.17773V1.17773M11.25 4.17773L8.25 1.17773L5.25 4.17773" stroke="currentColor"/><path d="M8.25 9.17773V14.1777M11.25 11.1777L8.25 14.1777L5.25 11.1777" stroke="currentColor"/><path d="M4.25 7.67773H12.25" stroke="currentColor"/>`,
  },
  filetree: {
    viewBox: "0 0 16 16",
    body: `<path d="M2.5 1.5V12.2484H6.75M2.5 4.74838H6.75" stroke="currentColor"/><rect x="8.5" y="3.2168" width="6" height="3" fill="none" stroke="currentColor"/><rect x="8.5" y="10.75" width="6" height="3" fill="none" stroke="currentColor"/>`,
  },
  split: {
    viewBox: "0 0 16 16",
    body: `<path d="M1 14H15L15 2H1V14Z" stroke="currentColor"/><rect x="3" y="4" width="4" height="8" fill="currentColor" fill-opacity="0.5"/><rect x="9" y="4" width="4" height="8" fill="currentColor" fill-opacity="0.5"/>`,
  },
  unified: {
    viewBox: "0 0 16 16",
    body: `<path d="M3.00001 4.00045L12.9998 4L13 6.99955L3 7L3.00001 4.00045Z" fill="currentColor" fill-opacity="0.5"/><path d="M3.0001 9H13L12.9999 12H3L3.0001 9Z" fill="currentColor" fill-opacity="0.5"/><path d="M1 14H15L15 2H1V14Z" stroke="currentColor"/>`,
  },
  review: {
    viewBox: "0 0 20 20",
    body: `<path d="M7 14.5H13M7 7.99512H10.0049M10.0049 7.99512H13M10.0049 7.99512V5M10.0049 7.99512V11M18 18V2L2 2L2 18H18Z" stroke="currentColor"/>`,
  },
  "window-analytics": {
    viewBox: "0 0 16 16",
    body: `<path d="M14.5 9.8333V13.5H1.5V2.5H7.1667M9.5 2.5V7.5H14.5V2.5H9.5Z" stroke="currentColor" stroke-miterlimit="10" stroke-linecap="square"/>`,
  },
  "graduation-cap": {
    viewBox: "0 0 16 16",
    body: `<path d="M12.3327 7.50065V11.0007L7.99935 13.6673L3.66602 11.0007V7.50065M14.3327 9.83398V6.16732M7.99935 2.33398L1.66602 6.00065L7.99935 10.0007L14.3327 6.00065L7.99935 2.33398Z" stroke="currentColor" stroke-linecap="square"/>`,
  },
  "code-slash": {
    viewBox: "0 0 16 16",
    body: `<path fill-rule="evenodd" clip-rule="evenodd" d="M10.0812 2.10803L6.55974 14.0809L5.92016 13.8928L9.44161 1.91992L10.0812 2.10803ZM4.13793 4.97275L1.44666 8.00045L4.13793 11.0281L3.63966 11.471L0.554688 8.00045L3.63966 4.52984L4.13793 4.97275ZM12.3617 4.52984L15.4467 8.00045L12.3617 11.471L11.8634 11.0281L14.5547 8.00045L11.8634 4.97275L12.3617 4.52984Z" fill="currentColor"/>`,
  },
  trash: {
    viewBox: "0 0 20 20",
    body: `<path d="M4.58342 17.9134L4.58369 17.4134L4.22787 17.5384L4.22766 18.0384H4.58342V17.9134ZM15.4167 17.9134V18.0384H15.7725L15.7723 17.5384L15.4167 17.9134ZM2.08342 3.95508V3.45508H1.58342V3.95508H2.08342V4.45508V3.95508ZM17.9167 4.45508V4.95508H18.4167V4.45508H17.9167V3.95508V4.45508ZM4.16677 4.58008L3.66701 4.5996L4.22816 17.5379L4.72792 17.4934L5.22767 17.4489L4.66652 4.54055L4.16677 4.58008ZM4.58342 18.0384V17.9134H15.4167V18.0384V18.5384H4.58342V18.0384ZM15.4167 17.9134L15.8332 17.5379L16.2498 4.5996L15.7501 4.58008L15.2503 4.56055L14.8337 17.4989L15.4167 17.9134ZM15.8334 4.58008V4.08008H4.16677V4.58008V5.08008H15.8334V4.58008ZM2.08342 4.45508V4.95508H4.16677V4.58008V4.08008H2.08342V4.45508ZM15.8334 4.58008V5.08008H17.9167V4.45508V3.95508H15.8334V4.58008ZM6.83951 4.35149L7.432 4.55047C7.79251 3.47701 8.80699 2.70508 10.0001 2.70508V2.20508V1.70508C8.25392 1.70508 6.77335 2.83539 6.24702 4.15251L6.83951 4.35149ZM10.0001 2.20508V2.70508C11.1932 2.70508 12.2077 3.47701 12.5682 4.55047L13.1607 4.35149L13.7532 4.15251C13.2269 2.83539 11.7463 1.70508 10.0001 1.70508V2.20508Z" fill="currentColor"/>`,
  },
  "outline-sliders": {
    viewBox: "0 0 16 16",
    body: `<path d="M11.7779 4.66675H14.4446M11.7779 4.66675C11.7779 5.77132 10.8825 6.66675 9.77789 6.66675C8.67332 6.66675 7.77789 5.77132 7.77789 4.66675M11.7779 4.66675C11.7779 3.56218 10.8825 2.66675 9.77789 2.66675C8.67332 2.66675 7.77789 3.56218 7.77789 4.66675M1.55566 4.66675H7.77789M4.22233 11.3334H1.55566M4.22233 11.3334C4.22233 12.438 5.11776 13.3334 6.22233 13.3334C7.3269 13.3334 8.22233 12.438 8.22233 11.3334M4.22233 11.3334C4.22233 10.2288 5.11776 9.33341 6.22233 9.33341C7.3269 9.33341 8.22233 10.2288 8.22233 11.3334M14.4446 11.3334H8.22233" stroke="currentColor"/>`,
  },
  "outline-copy": {
    viewBox: "0 0 16 16",
    body: `<path d="M4.14908 11.0081H1.76282V1.51758H9.1038V2.55588M14.2225 4.99681H6.75397V14.4873H14.2225V4.99681Z" stroke="currentColor"/>`,
  },
  "arrow-up-right": {
    viewBox: "0 0 16 16",
    body: `<path d="M11 9.56V5H6.44M11 5L5 11" stroke="currentColor"/>`,
  },
  "outline-square-arrow": {
    viewBox: "0 0 16 16",
    body: `<path d="M13.5555 6.66656V2.44434H9.33326M13.5555 2.44434L7.99993 7.99989M13.5555 9.33324V13.5555C13.5555 13.5555 12.7599 13.5555 11.7777 13.5555H2.44438C2.44438 13.5555 2.44438 12.7599 2.44438 11.7777V4.22213C2.44438 3.2399 2.44434 2.44435 2.44434 2.44435H6.66661" stroke="currentColor"/>`,
  },
  "outline-arrow-to-corner-top-right": {
    viewBox: "0 0 16 16",
    body: `<path d="M2 8.5V2H14V14H8M5 5.66667H10.3333V11M3.66797 12.333L9.94292 6.05806" stroke="currentColor" stroke-linecap="square"/>`,
  },
  "outline-hexagonal-warning": {
    viewBox: "0 0 16 16",
    body: `<path d="M10.6667 1.33325H5.33272L1.33334 5.33325L1.33342 10.6917L5.3327 14.691L10.6667 14.6909L14.6911 10.6917V5.33255L10.6667 1.33325Z" stroke="currentColor"/><path d="M8 10.6667H8.00667" stroke="currentColor" stroke-linecap="square"/><path d="M8 7.99992V5.33325" stroke="currentColor" stroke-linecap="square"/>`,
  },
  "outline-share": {
    viewBox: "0 0 16 16",
    body: `<path d="M13.5554 10.4445V13.5556C13.5554 13.5556 12.7599 13.5556 11.7777 13.5556H4.22211C3.23989 13.5556 2.44434 13.5556 2.44434 13.5556V10.4445M4.88878 5.55557L7.99989 2.44446L11.111 5.55557M7.99989 2.44446L7.99989 9.11112" stroke="currentColor"/>`,
  },
  "outline-eye": {
    viewBox: "0 0 20 20",
    body: `<path d="M2.5 10s3.33-5.42 7.5-5.42S17.5 10 17.5 10s-3.33 5.42-7.5 5.42S2.5 10 2.5 10Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10" cy="10" r="2.5" stroke="currentColor"/>`,
  },
  "outline-eye-slash": {
    viewBox: "0 0 20 20",
    body: `<path d="M2.5 10s3.33-5.42 7.5-5.42S17.5 10 17.5 10s-3.33 5.42-7.5 5.42S2.5 10 2.5 10Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10" cy="10" r="2.5" stroke="currentColor"/><path d="M3 3 17 17" stroke="currentColor" stroke-linecap="round"/>`,
  },
  refresh: {
    viewBox: "0 0 20 20",
    body: `<path d="M16.25 7.5A6.5 6.5 0 1 0 16.5 11M16.25 3.5v4h-4" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  reset: {
    viewBox: "0 0 20 20",
    body: `<path d="M5.83333 4.16406L2.5 7.4974L5.83333 10.8307M3.33333 7.4974H17.9167V15.4141H10" stroke="currentColor" stroke-linecap="square"/>`,
  },
  "outline-reset": {
    viewBox: "0 0 20 20",
    body: `<path d="M5.83333 4.16406L2.5 7.4974L5.83333 10.8307M3.33333 7.4974H17.9167V15.4141H10" stroke="currentColor" stroke-linecap="square"/>`,
  },
  "fill-triangle-down": {
    viewBox: "0 0 16 16",
    body: `<path d="M5.37624 6.75194C5.18184 6.41861 5.42224 6 5.80814 6H10.1921C10.578 6 10.8184 6.41861 10.624 6.75194L8.43203 10.5096C8.23909 10.8404 7.76119 10.8404 7.56825 10.5096L5.37624 6.75194Z" fill="currentColor"/>`,
  },
  archive: {
    viewBox: "0 0 16 16",
    body: `<path d="M13.1112 13.5555V14.0555H13.6112V13.5555H13.1112ZM2.889 13.5555H2.389L2.389 14.0555H2.889V13.5555ZM3.38901 5.55546L3.38901 5.05546L2.38901 5.05546L2.38901 5.55546L2.88901 5.55546L3.38901 5.55546ZM14.4446 2.44434H14.9446V1.94434L14.4446 1.94434L14.4446 2.44434ZM14.4446 5.55545L14.4446 6.05545L14.9446 6.05545V5.55545H14.4446ZM1.55566 5.55546L1.05566 5.55545L1.05566 6.05546L1.55566 6.05546L1.55566 5.55546ZM1.5557 2.44436L1.5557 1.94436L1.05571 1.94436L1.0557 2.44435L1.5557 2.44436ZM13.1112 5.55546H12.6112V13.5555H13.1112H13.6112V5.55546H13.1112ZM2.889 13.5555H3.389L3.38901 5.55546L2.88901 5.55546L2.38901 5.55546L2.389 13.5555H2.889ZM14.4446 2.44434H13.9446V5.55545H14.4446H14.9446V2.44434H14.4446ZM1.55566 5.55546L2.05566 5.55547L2.0557 2.44436L1.5557 2.44436L1.0557 2.44435L1.05566 5.55545L1.55566 5.55546ZM6.22234 8.22213V8.72213H9.7779V8.22213V7.72213H6.22234V8.22213ZM13.1112 13.5555V13.0555H2.889V13.5555V14.0555H13.1112V13.5555ZM1.5557 2.44436L1.5557 2.94436L14.4446 2.94434L14.4446 2.44434L14.4446 1.94434L1.5557 1.94436L1.5557 2.44436ZM14.4446 5.55545L14.4446 5.05545L1.55566 5.05546L1.55566 5.55546L1.55566 6.05546L14.4446 6.05545L14.4446 5.55545Z" fill="currentColor"/>`,
  },
}

type IconName = keyof typeof icons | keyof typeof additionalIcons

const spriteID = "opencode-v2-icon-sprite"
const symbol = (name: IconName) => `opencode-v2-icon-${name}`
let spriteInserted = false

function getIcon(name: IconName) {
  const icon = icons[name as keyof typeof icons]
  if (icon) return icon
  const body = additionalIcons[name as keyof typeof additionalIcons]
  return { body, viewBox: additionalIconViewBox(name as keyof typeof additionalIcons) }
}

function spriteContent() {
  return Array.from(new Set<IconName>([...Object.keys(additionalIcons), ...Object.keys(icons)] as IconName[]))
    .map((name) => `<symbol id="${symbol(name)}" viewBox="${getIcon(name).viewBox}">${getIcon(name).body}</symbol>`)
    .join("")
}

function ensureSprite() {
  if (spriteInserted) return
  if (typeof document === "undefined") return
  // Hot reload preserves the DOM sprite, but its symbols may be from an older module.
  const existing = document.getElementById(spriteID)
  if (existing) {
    existing.innerHTML = spriteContent()
    spriteInserted = true
    return
  }

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.id = spriteID
  svg.setAttribute("aria-hidden", "true")
  svg.setAttribute("width", "0")
  svg.setAttribute("height", "0")
  svg.style.position = "absolute"
  svg.style.overflow = "hidden"
  svg.innerHTML = spriteContent()
  document.body.insertBefore(svg, document.body.firstChild)
  spriteInserted = true
}

export interface IconProps extends ComponentProps<"svg"> {
  name: IconName | (string & {})
  size?: "small" | "normal" | "large"
}

export function Icon(props: IconProps) {
  const [split, rest] = splitProps(props, ["name", "size"])
  const iconName = (): IconName => {
    if (icons[split.name as keyof typeof icons]) return split.name as keyof typeof icons
    if (additionalIcons[split.name as keyof typeof additionalIcons]) return split.name as keyof typeof additionalIcons
    return "plus"
  }
  const icon = () => getIcon(iconName())
  const pixelSize = split.size === "small" ? 14 : split.size === "large" ? 20 : 16
  onMount(ensureSprite)

  return (
    <svg
      {...rest}
      data-slot="icon-svg"
      data-directional={
        iconName() === "arrow-left" ||
        iconName() === "arrow-right" ||
        iconName() === "chevron-left" ||
        iconName() === "chevron-right"
          ? ""
          : undefined
      }
      width={pixelSize}
      height={pixelSize}
      viewBox={icon().viewBox}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={rest["aria-hidden"] ?? "true"}
    >
      <use href={`#${symbol(iconName())}`} />
    </svg>
  )
}
