TRUNCATE TABLE jst_flat.commodity_price;

INSERT INTO jst_flat.commodity_price (
    dat, z101030, z101010, z101020, z102030, z102010, z102020,
    z103030, z103010, z103020, z104030, z104010, z104020,
    z201030, z201010, z201020, z202030, z202010, z202020,
    z204030, z204010, z204020,
    z301030, z301010, z301020, z302030, z302010, z302020,
    zl302030, zl302010, zl302020,
    zdc01zd, zdc01zg, zdc01jj,
    zdx51dzd, zdx51dzg, zdx51djj,
    zq235bzd, zq235bzg, zq235bjj,
    z401030, z401010, z401020, z402030, z402010, z402020,
    z501000, z502000, z601000, zlmet, z602000, zlmel,
    huilv, zgqstsl, beizhu, beizhu2,
    zshfet, zshfel, znlmet, znlmel
)
SELECT
    dat, z101030, z101010, z101020, z102030, z102010, z102020,
    z103030, z103010, z103020, z104030, z104010, z104020,
    z201030, z201010, z201020, z202030, z202010, z202020,
    z204030, z204010, z204020,
    z301030, z301010, z301020, z302030, z302010, z302020,
    zl302030, zl302010, zl302020,
    zdc01zd, zdc01zg, zdc01jj,
    zdx51dzd, zdx51dzg, zdx51djj,
    zq235bzd, zq235bzg, zq235bjj,
    z401030, z401010, z401020, z402030, z402010, z402020,
    z501000, z502000, z601000, zlmet, z602000, zlmel,
    huilv, zgqstsl, beizhu, beizhu2,
    zshfet, zshfel, znlmet, znlmel
FROM dwd_dcp.DWD_S4_ZTMM_JSCGJG;
