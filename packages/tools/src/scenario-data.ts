import type { MapFeature, Point, RouteLandmark, SourceCard } from "@maps/schemas";

export interface GeoAnchor {
  latitude: number;
  longitude: number;
}

export const sourceCards: SourceCard[] = [
  {
    id: "source-tianditu",
    title: "Tianditu 合规底图链路",
    provider: "Tianditu",
    note: "公开模式默认使用国内合规 provider 抽象。"
  },
  {
    id: "source-scenarios",
    title: "场景数据集",
    provider: "Curated Dataset",
    note: "POI、区域讲解与路线摘要来自当前仓库内置场景数据，不代表实时导航结果。"
  }
];

export const scenarioFeatures: MapFeature[] = [
  {
    id: "district-pudong",
    name: "浦东新区",
    aliases: ["浦东", "pudong new area"],
    kind: "district",
    description: "浦东新区区域视图，覆盖陆家嘴、张江等重点功能区。",
    bbox: [56, 18, 90, 70],
    centroid: [73, 44],
    tags: ["district", "finance", "innovation"],
    narrativeBullets: ["金融核心带", "科技创新走廊", "大型会展与国际门户"]
  },
  {
    id: "landmark-lujiazui",
    name: "陆家嘴",
    aliases: ["lujiazui"],
    kind: "landmark",
    description: "金融地标密集区，适合做城市形象与产业能级展示。",
    bbox: [63, 28, 73, 42],
    centroid: [68, 35],
    tags: ["finance", "skyline"],
    narrativeBullets: ["金融总部集聚", "滨江天际线", "国际商务展示"]
  },
  {
    id: "campus-zhangjiang",
    name: "张江科学城",
    aliases: ["张江", "zhangjiang"],
    kind: "campus",
    description: "以集成电路、生物医药、AI 为代表的科技园区区域。",
    bbox: [72, 45, 86, 62],
    centroid: [79, 53],
    tags: ["science", "industry"],
    narrativeBullets: ["集成电路", "生物医药", "人工智能"]
  },
  {
    id: "hub-pudong-airport",
    name: "浦东国际机场",
    aliases: ["浦东机场", "机场", "pvg"],
    kind: "hub",
    description: "东向航空门户，适合展示国际到达与城市接入。",
    bbox: [86, 58, 96, 72],
    centroid: [91, 65],
    tags: ["airport", "transport"],
    narrativeBullets: ["国际航空门户", "东向综合交通节点"]
  },
  {
    id: "hub-hongqiao",
    name: "虹桥交通枢纽",
    aliases: ["虹桥枢纽", "虹桥机场", "机场", "hongqiao"],
    kind: "hub",
    description: "西向交通门户，连接会展、机场与高铁功能。",
    bbox: [14, 34, 28, 48],
    centroid: [21, 41],
    tags: ["airport", "rail", "hub"],
    narrativeBullets: ["高铁与机场一体化", "会展门户", "西向城市入口"]
  },
  {
    id: "venue-necc",
    name: "国家会展中心",
    aliases: ["会展中心", "国家会展中心", "necc"],
    kind: "venue",
    description: "大型会展活动承载区，适合展示展馆与综合配套。",
    bbox: [27, 39, 37, 49],
    centroid: [32, 44],
    tags: ["expo", "venue"],
    narrativeBullets: ["大型会展承载", "商业配套", "交通组织"]
  }
];

export const routeLandmarksById: Record<string, RouteLandmark[]> = {
  "route-pvg-necc": [
    {
      featureId: "landmark-lujiazui",
      name: "陆家嘴",
      summary: "适合作为进入中心城区后的金融地标讲解节点。",
      point: [68, 35]
    },
    {
      featureId: "campus-zhangjiang",
      name: "张江科学城",
      summary: "适合作为科技产业带的重点讲解节点。",
      point: [79, 53]
    },
    {
      featureId: "hub-hongqiao",
      name: "虹桥交通枢纽",
      summary: "适合作为会展门户与交通枢纽的一体化节点。",
      point: [21, 41]
    }
  ],
  "route-hq-necc": [
    {
      featureId: "hub-hongqiao",
      name: "虹桥交通枢纽",
      summary: "从机场、高铁到会展功能的衔接最为集中。",
      point: [21, 41]
    },
    {
      featureId: "venue-necc",
      name: "国家会展中心",
      summary: "终点适合直接进入展馆与周边配套讲解。",
      point: [32, 44]
    }
  ]
};

export const routePathsById: Record<string, Point[]> = {
  "route-pvg-necc": [
    [91, 65],
    [82, 58],
    [74, 50],
    [66, 37],
    [49, 35],
    [36, 41],
    [32, 44]
  ],
  "route-hq-necc": [
    [21, 41],
    [25, 43],
    [32, 44]
  ]
};

export const geoAnchorsByFeatureId: Record<string, GeoAnchor> = {
  "district-pudong": {
    latitude: 31.2269,
    longitude: 121.5447
  },
  "landmark-lujiazui": {
    latitude: 31.2397,
    longitude: 121.5064
  },
  "campus-zhangjiang": {
    latitude: 31.2011,
    longitude: 121.5944
  },
  "hub-pudong-airport": {
    latitude: 31.1443,
    longitude: 121.8052
  },
  "hub-hongqiao": {
    latitude: 31.1973,
    longitude: 121.3275
  },
  "venue-necc": {
    latitude: 31.1916,
    longitude: 121.2998
  }
};

export const defaultGeoAnchor: GeoAnchor = {
  latitude: 31.2304,
  longitude: 121.4737
};
