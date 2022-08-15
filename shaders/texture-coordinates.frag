#version 330
#extension GL_ARB_shading_language_420pack : require

#include "const.h.glsl"
#include "texture-coordinates.h.glsl"
#include "common-functions.h.glsl"

const float LENGTH_OF_HORIZ_RAY_FROM_GROUND_TO_TOA=sqrt(atmosphereHeight*(atmosphereHeight+2*earthRadius));

uniform sampler2D transmittanceTexture;
uniform float staticAltitudeTexCoord=-1;
uniform float eclipsedDoubleScatteringAltitudeAlphaUpper;
uniform vec3 eclipsedDoubleScatteringTextureSize;

struct Scattering4DCoords
{
    float cosSunZenithAngle;
    float cosViewZenithAngle;
    float dotViewSun;
    float altitude;
    bool viewRayIntersectsGround;
};
struct TexCoordPair
{
    vec3 lower;
    float alphaLower;
    vec3 upper;
    float alphaUpper;
};

struct EclipseScattering2DCoords
{
    float azimuth;
    float cosViewZenithAngle;
};

float texCoordToUnitRange(const float texCoord, const float texSize)
{
    return (texSize*texCoord-0.5)/(texSize-1);
}

float unitRangeToTexCoord(const float u, const float texSize)
{
    return (0.5+(texSize-1)*u)/texSize;
}

vec2 unitRangeToTexCoord(const vec2 u, const float texSize)
{
    return vec2(unitRangeToTexCoord(u.s,texSize),
                unitRangeToTexCoord(u.t,texSize));
}

TransmittanceTexVars transmittanceTexCoordToTexVars(const vec2 texCoord)
{
    const float distToHorizon=LENGTH_OF_HORIZ_RAY_FROM_GROUND_TO_TOA *
                                texCoordToUnitRange(texCoord.t,transmittanceTextureSize.t);
    // Distance from Earth center to camera
    const float r=sqrt(sqr(distToHorizon)+sqr(earthRadius));
    const float altitude=r-earthRadius;

    const float dMin=atmosphereHeight-altitude; // distance to zenith
    const float dMax=LENGTH_OF_HORIZ_RAY_FROM_GROUND_TO_TOA+distToHorizon;
    // distance to border of visible atmosphere from the view point
    const float d=dMin+(dMax-dMin)*texCoordToUnitRange(texCoord.s,transmittanceTextureSize.s);
    // d==0 can happen when altitude==atmosphereHeight
    const float cosVZA = d==0 ? 1 : (2*r*dMin+sqr(dMin)-sqr(d))/(2*r*d);
    return TransmittanceTexVars(cosVZA,altitude);
}

// cosVZA: cos(viewZenithAngle)
//  Instead of cosVZA itself, distance to the atmosphere border along the view ray is
// used as the texture parameter. This lets us make sure the function is sampled
// with decent resolution near true horizon and avoids useless oversampling near
// zenith.
//  Instead of altitude itself, ratio of distance-to-horizon to
// length-of-horizontal-ray-from-ground-to-atmosphere-border is used to improve
// resolution at low altitudes, where transmittance has noticeable but very thin
// dip near horizon.
//  NOTE: this function relies on transmittanceTexture sampler being defined
vec2 transmittanceTexVarsToTexCoord(const float cosVZA, float altitude)
{
    if(altitude<0)
        altitude=0;

    const float distToHorizon=sqrt(sqr(altitude)+2*altitude*earthRadius);
    const float t=unitRangeToTexCoord(distToHorizon / LENGTH_OF_HORIZ_RAY_FROM_GROUND_TO_TOA,
                                      transmittanceTextureSize.t);
    const float dMin=atmosphereHeight-altitude; // distance to zenith
    const float dMax=LENGTH_OF_HORIZ_RAY_FROM_GROUND_TO_TOA+distToHorizon;
    const float d=distanceToAtmosphereBorder(cosVZA,altitude);
    const float s=unitRangeToTexCoord((d-dMin)/(dMax-dMin), transmittanceTextureSize.s);
    return vec2(s,t);
}

// Output: vec2(cos(sunZenithAngle), altitude)
IrradianceTexVars irradianceTexCoordToTexVars(const vec2 texCoord)
{
    const float cosSZA=2*texCoordToUnitRange(texCoord.s, irradianceTextureSize.s)-1;
    const float alt=atmosphereHeight*texCoordToUnitRange(texCoord.t, irradianceTextureSize.t);
    return IrradianceTexVars(cosSZA,alt);
}

vec2 irradianceTexVarsToTexCoord(const float cosSunZenithAngle, const float altitude)
{
    const float s=unitRangeToTexCoord((cosSunZenithAngle+1)/2, irradianceTextureSize.s);
    const float t=unitRangeToTexCoord(altitude/atmosphereHeight, irradianceTextureSize.t);
    return vec2(s,t);
}

float cosSZAToUnitRangeTexCoord(const float cosSunZenithAngle)
{
    // Distance to top atmosphere border along the ray groundUnderCamera-sun: (altitude, cosSunZenithAngle)
    const float distFromGroundToTopAtmoBorder=distanceToAtmosphereBorder(cosSunZenithAngle, 0.);
    const float distMin=atmosphereHeight;
    const float distMax=LENGTH_OF_HORIZ_RAY_FROM_GROUND_TO_TOA;
    // TODO: choose a more descriptive name
    const float a=(distFromGroundToTopAtmoBorder-distMin)/(distMax-distMin);
    // TODO: choose a more descriptive name
    const float A=2*earthRadius/(distMax-distMin);
    return max(0.,1-a/A)/(a+1);
}

float unitRangeTexCoordToCosSZA(const float texCoord)
{
    const float distMin=atmosphereHeight;
    const float distMax=LENGTH_OF_HORIZ_RAY_FROM_GROUND_TO_TOA;
    // TODO: choose a more descriptive name, same as in cosSZAToUnitRangeTexCoord()
    const float A=2*earthRadius/(distMax-distMin);
    // TODO: choose a more descriptive name, same as in cosSZAToUnitRangeTexCoord()
    const float a=(A-A*texCoord)/(1+A*texCoord);
    const float distFromGroundToTopAtmoBorder=distMin+min(a,A)*(distMax-distMin);
    return distFromGroundToTopAtmoBorder==0 ? 1 :
        clampCosine((sqr(LENGTH_OF_HORIZ_RAY_FROM_GROUND_TO_TOA)-sqr(distFromGroundToTopAtmoBorder)) /
                    (2*earthRadius*distFromGroundToTopAtmoBorder));
}

// dotViewSun: dot(viewDir,sunDir)
Scattering4DCoords scatteringTexVarsTo4DCoords(const float cosSunZenithAngle, const float cosViewZenithAngle,
                                               const float dotViewSun, const float altitude,
                                               const bool viewRayIntersectsGround)
{
    const float r=earthRadius+altitude;

    const float distToHorizon    = sqrt(sqr(altitude)+2*altitude*earthRadius);
    const float altCoord = distToHorizon / LENGTH_OF_HORIZ_RAY_FROM_GROUND_TO_TOA;

    // ------------------------------------
    float cosVZACoord; // Coordinate for cos(viewZenithAngle)
    const float rCvza=r*cosViewZenithAngle;
    // Discriminant of the quadratic equation for the intersections of the ray (altitiude, cosViewZenithAngle) with the ground.
    const float discriminant=sqr(rCvza)-sqr(r)+sqr(earthRadius);
    if(viewRayIntersectsGround)
    {
        // Distance from camera to the ground along the view ray (altitude, cosViewZenithAngle)
        const float distToGround = -rCvza-safeSqrt(discriminant);
        // Minimum possible value of distToGround
        const float distMin = altitude;
        // Maximum possible value of distToGround
        const float distMax = distToHorizon;
        cosVZACoord = distMax==distMin ? 0. : (distToGround-distMin)/(distMax-distMin);
    }
    else
    {
        // Distance from camera to the atmosphere border along the view ray (altitude, cosViewZenithAngle)
        // sqr(LENGTH_OF_HORIZ_RAY_FROM_GROUND_TO_TOA) added to sqr(earthRadius) term in discriminant changes
        // sqr(earthRadius) to sqr(earthRadius+atmosphereHeight), so that we target the top atmosphere boundary instead of bottom.
        const float distToTopAtmoBorder = -rCvza+safeSqrt(discriminant+sqr(LENGTH_OF_HORIZ_RAY_FROM_GROUND_TO_TOA));
        const float distMin = atmosphereHeight-altitude;
        const float distMax = distToHorizon+LENGTH_OF_HORIZ_RAY_FROM_GROUND_TO_TOA;
        cosVZACoord = distMax==distMin ? 0. : (distToTopAtmoBorder-distMin)/(distMax-distMin);
    }

    // ------------------------------------
    const float dotVSCoord=(dotViewSun+1)/2;

    // ------------------------------------
    const float cosSZACoord=cosSZAToUnitRangeTexCoord(cosSunZenithAngle);

    return Scattering4DCoords(cosSZACoord, cosVZACoord, dotVSCoord, altCoord, viewRayIntersectsGround);
}

TexCoordPair scattering4DCoordsToTexCoords(const Scattering4DCoords coords,
                                           const bool forInterpolationGuides01, const bool forInterpolationGuides02)
{
    const float cosVZAtc = coords.viewRayIntersectsGround ?
                            // Coordinate is in ~[0,0.5]
                            0.5-0.5*unitRangeToTexCoord(coords.cosViewZenithAngle, scatteringTextureSize[0]/2) :
                            // Coordinate is in ~[0.5,1]
                            0.5+0.5*unitRangeToTexCoord(coords.cosViewZenithAngle, scatteringTextureSize[0]/2);

    // Width and height of the 2D subspace of the 4D texture - the subspace spanned by
    // the texture coordinates we combine into a single sampler3D coordinate.
    const float texW = forInterpolationGuides01 ? scatteringTextureSize[1]-1 : scatteringTextureSize[1];
    const float texH = forInterpolationGuides02 ? scatteringTextureSize[2]-1 : scatteringTextureSize[2];
    const float cosSZAIndex=coords.cosSunZenithAngle*(texH-1);
    const vec2 combiCoordUnitRange=vec2(floor(cosSZAIndex)*texW+coords.dotViewSun*(texW-1),
                                        ceil (cosSZAIndex)*texW+coords.dotViewSun*(texW-1)) / (texW*texH-1);
    const vec2 combinedCoord=unitRangeToTexCoord(combiCoordUnitRange, texW*texH);

    const float altitude = staticAltitudeTexCoord>=0 ? staticAltitudeTexCoord
                                                     : unitRangeToTexCoord(coords.altitude, scatteringTextureSize[3]);

    const float alphaUpper=fract(cosSZAIndex);
    return TexCoordPair(vec3(cosVZAtc, combinedCoord.x, altitude), float(1-alphaUpper),
                        vec3(cosVZAtc, combinedCoord.y, altitude), float(alphaUpper));
}

vec4 sample4DTexture(const sampler3D tex, const float cosSunZenithAngle, const float cosViewZenithAngle,
                     const float dotViewSun, const float altitude, const bool viewRayIntersectsGround)
{
    const Scattering4DCoords coords4d = scatteringTexVarsTo4DCoords(cosSunZenithAngle,cosViewZenithAngle,
                                                                    dotViewSun,altitude,viewRayIntersectsGround);
    const TexCoordPair texCoords=scattering4DCoordsToTexCoords(coords4d, false, false);
    return texture(tex, texCoords.lower) * texCoords.alphaLower +
           texture(tex, texCoords.upper) * texCoords.alphaUpper;
}

vec4 sample4DTextureGuided01_log(const sampler3D tex, const sampler3D interpolationGuides01Tex,
                                 const Scattering4DCoords coords4d)
{
    const TexCoordPair guidesCoords = scattering4DCoordsToTexCoords(coords4d, true, false);
    const float guidesTex = texture(interpolationGuides01Tex, guidesCoords.lower).r * guidesCoords.alphaLower +
                            texture(interpolationGuides01Tex, guidesCoords.upper).r * guidesCoords.alphaUpper;
    const float interpAngle = PI/2*guidesTex;

    const float cosVZAIndex = coords4d.cosViewZenithAngle * (scatteringTextureSize[0]-1);
    const float dotVSIndex = coords4d.dotViewSun * (scatteringTextureSize[1]-1);
    const float currRow = floor(dotVSIndex);
    const float posBetweenRows = dotVSIndex - currRow;
    const float cvzaPosInCurrRow = cosVZAIndex - posBetweenRows*tan(interpAngle);
    const float cvzaPosInNextRow = cosVZAIndex + (1-posBetweenRows)*tan(interpAngle);

    Scattering4DCoords coords4dCurrRow = coords4d, coords4dNextRow = coords4d;
    coords4dCurrRow.cosViewZenithAngle = clamp(cvzaPosInCurrRow / (scatteringTextureSize[0]-1), 0., 1.);
    coords4dNextRow.cosViewZenithAngle = clamp(cvzaPosInNextRow / (scatteringTextureSize[0]-1), 0., 1.);
    coords4dCurrRow.dotViewSun =      currRow    / (scatteringTextureSize[1]-1);
    coords4dNextRow.dotViewSun = min((currRow+1) / (scatteringTextureSize[1]-1), 1.);

    const TexCoordPair coordsNextRow = scattering4DCoordsToTexCoords(coords4dNextRow, false, false);
    const TexCoordPair coordsCurrRow = scattering4DCoordsToTexCoords(coords4dCurrRow, false, false);

    const vec4 valueCurrRow = texture(tex, coordsCurrRow.lower) * coordsCurrRow.alphaLower +
                              texture(tex, coordsCurrRow.upper) * coordsCurrRow.alphaUpper;
    const vec4 valueNextRow = texture(tex, coordsNextRow.lower) * coordsNextRow.alphaLower +
                              texture(tex, coordsNextRow.upper) * coordsNextRow.alphaUpper;
    const float epsilon = 1e-37; // Prevents passing zero to log
    const vec4 logValNextRow = log(max(valueNextRow, vec4(epsilon)));
    const vec4 logValCurrRow = log(max(valueCurrRow, vec4(epsilon)));
    return (logValNextRow-logValCurrRow) * posBetweenRows + logValCurrRow;
}

vec4 sample4DTextureGuided(const sampler3D tex,
                           const sampler3D interpolationGuides01Tex, const sampler3D interpolationGuides02Tex,
                           const float cosSunZenithAngle, const float cosViewZenithAngle,
                           const float dotViewSun, const float altitude, const bool viewRayIntersectsGround)
{
    const Scattering4DCoords coords4d = scatteringTexVarsTo4DCoords(cosSunZenithAngle, cosViewZenithAngle,
                                                                    dotViewSun, altitude, viewRayIntersectsGround);
    // Handle the external interpolation guides: the guides between a pair of VZA-dotViewSun 2D "pictures".
    const TexCoordPair guidesCoords = scattering4DCoordsToTexCoords(coords4d, false, true);
    const float guidesTex = texture(interpolationGuides02Tex, guidesCoords.lower).r * guidesCoords.alphaLower +
                            texture(interpolationGuides02Tex, guidesCoords.upper).r * guidesCoords.alphaUpper;
    const float interpAngle = PI/2*guidesTex;

    const float cosVZAIndex = coords4d.cosViewZenithAngle * (scatteringTextureSize[0]-1);
    const float cszaIndex = coords4d.cosSunZenithAngle * (scatteringTextureSize[2]-1);
    const float currRow = floor(cszaIndex);
    const float posBetweenRows = cszaIndex - currRow;
    const float cvzaPosInCurrRow = cosVZAIndex - posBetweenRows*tan(interpAngle);
    const float cvzaPosInNextRow = cosVZAIndex + (1-posBetweenRows)*tan(interpAngle);

    Scattering4DCoords coords4dCurrRow = coords4d, coords4dNextRow = coords4d;
    coords4dCurrRow.cosViewZenithAngle = clamp(cvzaPosInCurrRow / (scatteringTextureSize[0]-1), 0., 1.);
    coords4dNextRow.cosViewZenithAngle = clamp(cvzaPosInNextRow / (scatteringTextureSize[0]-1), 0., 1.);
    coords4dCurrRow.cosSunZenithAngle =      currRow    / (scatteringTextureSize[2]-1);
    coords4dNextRow.cosSunZenithAngle = min((currRow+1) / (scatteringTextureSize[2]-1), 1.);

    // The caller will handle the internal interpolation guides: the ones between rows in each 2D "picture".
    const vec4 logValCurrRow = sample4DTextureGuided01_log(tex, interpolationGuides01Tex, coords4dCurrRow);
    const vec4 logValNextRow = sample4DTextureGuided01_log(tex, interpolationGuides01Tex, coords4dNextRow);
    return exp((logValNextRow-logValCurrRow) * posBetweenRows + logValCurrRow);
}

ScatteringTexVars scatteringTex4DCoordsToTexVars(const Scattering4DCoords coords)
{
    const float distToHorizon = coords.altitude*LENGTH_OF_HORIZ_RAY_FROM_GROUND_TO_TOA;
    // Rounding errors can result in altitude>max, breaking the code after this calculation, so we have to clamp.
    const float altitude=clampAltitude(sqrt(sqr(distToHorizon)+sqr(earthRadius))-earthRadius);

    // ------------------------------------
    float cosViewZenithAngle;
    if(coords.viewRayIntersectsGround)
    {
        const float distMin=altitude;
        const float distMax=distToHorizon;
        const float distToGround=coords.cosViewZenithAngle*(distMax-distMin)+distMin;
        cosViewZenithAngle = distToGround==0 ? -1 :
            clampCosine(-(sqr(distToHorizon)+sqr(distToGround)) / (2*distToGround*(altitude+earthRadius)));
    }
    else
    {
        const float distMin=atmosphereHeight-altitude;
        const float distMax=distToHorizon+LENGTH_OF_HORIZ_RAY_FROM_GROUND_TO_TOA;
        const float distToTopAtmoBorder=coords.cosViewZenithAngle*(distMax-distMin)+distMin;
        cosViewZenithAngle = distToTopAtmoBorder==0 ? 1 :
            clampCosine((sqr(LENGTH_OF_HORIZ_RAY_FROM_GROUND_TO_TOA)-sqr(distToHorizon)-sqr(distToTopAtmoBorder)) /
                        (2*distToTopAtmoBorder*(altitude+earthRadius)));
    }

    // ------------------------------------
    const float dotViewSun=coords.dotViewSun*2-1;

    // ------------------------------------
    const float cosSunZenithAngle=unitRangeTexCoordToCosSZA(coords.cosSunZenithAngle);

    return ScatteringTexVars(cosSunZenithAngle, cosViewZenithAngle, dotViewSun, altitude, coords.viewRayIntersectsGround);
}

Scattering4DCoords scatteringTexIndicesTo4DCoords(const vec3 texIndices)
{
    const vec4 indexMax=scatteringTextureSize-vec4(1);
    Scattering4DCoords coords4d;
    coords4d.viewRayIntersectsGround = texIndices[0] < indexMax[0]/2;
    // The following formulas assume that scatteringTextureSize[0] is even. For odd sizes they would change.
    coords4d.cosViewZenithAngle = coords4d.viewRayIntersectsGround ?
                                   1-2*texIndices[0]/(indexMax[0]-1) :
                                   2*(texIndices[0]-1)/(indexMax[0]-1)-1;
    // Although the above formula, when compiled as written above, should produce exact result for zenith and nadir,
    // aggressive optimizations of NVIDIA driver can and do result in inexact coordinate. And this is bad, since our
    // further calculations in scatteringTex4DCoordsToTexVars are sensitive to these values when altitude==atmosphereHeight,
    // when looking into zenith. So let's fixup this special case.
    if(texIndices[0]==scatteringTextureSize[0]/2)
        coords4d.cosViewZenithAngle=0;

    // Width and height of the 2D subspace of the 4D texture - the subspace spanned by
    // the texture indices we combine into a single sampler3D coordinate.
    const float texW=scatteringTextureSize[1], texH=scatteringTextureSize[2];
    const float combinedIndex=texIndices[1];
    coords4d.dotViewSun=mod(combinedIndex,texW)/(texW-1);
    coords4d.cosSunZenithAngle=floor(combinedIndex/texW)/(texH-1);

    // NOTE: Third texture coordinate must correspond to only one 4D coordinate, because GL_MAX_3D_TEXTURE_SIZE is
    // usually much smaller than GL_MAX_TEXTURE_SIZE. So we can safely pack two of the 4D coordinates into width or
    // height, but not into depth.
    coords4d.altitude=texIndices[2]/indexMax[3];

    return coords4d;
}

ScatteringTexVars scatteringTexIndicesToTexVars(const vec3 texIndices)
{
    const Scattering4DCoords coords4d=scatteringTexIndicesTo4DCoords(texIndices);
    ScatteringTexVars vars=scatteringTex4DCoordsToTexVars(coords4d);
    // Clamp dotViewSun to its valid range of values, given cosViewZenithAngle and cosSunZenithAngle. This is
    // needed to prevent NaNs when computing the scattering texture.
    const float cosVZA=vars.cosViewZenithAngle,
                cosSZA=vars.cosSunZenithAngle;
    vars.dotViewSun=clamp(vars.dotViewSun,
                          cosVZA*cosSZA-safeSqrt((1-sqr(cosVZA))*(1-sqr(cosSZA))),
                          cosVZA*cosSZA+safeSqrt((1-sqr(cosVZA))*(1-sqr(cosSZA))));
    return vars;
}

EclipseScatteringTexVars eclipseTexCoordsToTexVars(const vec2 texCoords, const float altitude)
{
    const float distToHorizon = sqrt(sqr(altitude)+2*altitude*earthRadius);

    const bool viewRayIntersectsGround = texCoords.t<0.5;
    float cosViewZenithAngle;
    if(viewRayIntersectsGround)
    {
        const float cosVZACoord = texCoordToUnitRange(1-2*texCoords.t, eclipsedSingleScatteringTextureSize.t/2);
        const float distMin=altitude;
        const float distMax=distToHorizon;
        const float distToGround=cosVZACoord*(distMax-distMin)+distMin;
        cosViewZenithAngle = distToGround==0 ? -1 :
            clampCosine(-(sqr(distToHorizon)+sqr(distToGround)) / (2*distToGround*(altitude+earthRadius)));
    }
    else
    {
        const float cosVZACoord = texCoordToUnitRange(2*texCoords.t-1, eclipsedSingleScatteringTextureSize.t/2);
        const float distMin=atmosphereHeight-altitude;
        const float distMax=distToHorizon+LENGTH_OF_HORIZ_RAY_FROM_GROUND_TO_TOA;
        const float distToTopAtmoBorder=cosVZACoord*(distMax-distMin)+distMin;
        cosViewZenithAngle = distToTopAtmoBorder==0 ? 1 :
            clampCosine((sqr(LENGTH_OF_HORIZ_RAY_FROM_GROUND_TO_TOA)-sqr(distToHorizon)-sqr(distToTopAtmoBorder)) /
                        (2*distToTopAtmoBorder*(altitude+earthRadius)));
    }

    const float azimuthRelativeToSun = 2*PI*(texCoords.s - 1/(2*eclipsedSingleScatteringTextureSize.s));
    return EclipseScatteringTexVars(azimuthRelativeToSun, cosViewZenithAngle, viewRayIntersectsGround);
}

EclipseScattering2DCoords eclipseTexVarsTo2DCoords(const float azimuthRelativeToSun, const float cosViewZenithAngle,
                                                   const float altitude, const bool viewRayIntersectsGround)
{
    const float r=earthRadius+altitude;

    const float distToHorizon    = sqrt(sqr(altitude)+2*altitude*earthRadius);

    // ------------------------------------
    float cosVZACoord; // Coordinate for cos(viewZenithAngle)
    const float rCvza=r*cosViewZenithAngle;
    // Discriminant of the quadratic equation for the intersections of the ray (altitiude, cosViewZenithAngle) with the ground.
    const float discriminant=sqr(rCvza)-sqr(r)+sqr(earthRadius);
    if(viewRayIntersectsGround)
    {
        // Distance from camera to the ground along the view ray (altitude, cosViewZenithAngle)
        const float distToGround = -rCvza-safeSqrt(discriminant);
        // Minimum possible value of distToGround
        const float distMin = altitude;
        // Maximum possible value of distToGround
        const float distMax = distToHorizon;
        cosVZACoord = distMax==distMin ? 0. : (distToGround-distMin)/(distMax-distMin);
    }
    else
    {
        // Distance from camera to the atmosphere border along the view ray (altitude, cosViewZenithAngle)
        // sqr(LENGTH_OF_HORIZ_RAY_FROM_GROUND_TO_TOA) added to sqr(earthRadius) term in discriminant changes
        // sqr(earthRadius) to sqr(earthRadius+atmosphereHeight), so that we target the top atmosphere boundary instead of bottom.
        const float distToTopAtmoBorder = -rCvza+safeSqrt(discriminant+sqr(LENGTH_OF_HORIZ_RAY_FROM_GROUND_TO_TOA));
        const float distMin = atmosphereHeight-altitude;
        const float distMax = distToHorizon+LENGTH_OF_HORIZ_RAY_FROM_GROUND_TO_TOA;
        cosVZACoord = distMax==distMin ? 0. : (distToTopAtmoBorder-distMin)/(distMax-distMin);
    }

    const float azimuthCoord = azimuthRelativeToSun/(2*PI);

    return EclipseScattering2DCoords(azimuthCoord, cosVZACoord);
}

vec2 eclipseTexVarsToTexCoords(const float azimuthRelativeToSun, const float cosViewZenithAngle,
                               const float altitude, const bool viewRayIntersectsGround, const vec2 texSize)
{
    const EclipseScattering2DCoords coords=eclipseTexVarsTo2DCoords(azimuthRelativeToSun, cosViewZenithAngle, altitude,
                                                                    viewRayIntersectsGround);
    const float cosVZAtc = viewRayIntersectsGround ?
                            // Coordinate is in ~[0,0.5]
                            0.5-0.5*unitRangeToTexCoord(coords.cosViewZenithAngle, texSize.t/2) :
                            // Coordinate is in ~[0.5,1]
                            0.5+0.5*unitRangeToTexCoord(coords.cosViewZenithAngle, texSize.t/2);
    const float azimuthTC = coords.azimuth + 1/(2*texSize.s);

    return vec2(azimuthTC, cosVZAtc);
}

vec4 sampleEclipseDoubleScattering4DTexture(sampler3D texLower, sampler3D texUpper, const float cosSunZenithAngle,
                                            const float cosViewZenithAngle, const float azimuthRelativeToSun,
                                            const float altitude, const bool viewRayIntersectsGround)
{
    const vec2 coords2d=eclipseTexVarsToTexCoords(azimuthRelativeToSun, cosViewZenithAngle, altitude, viewRayIntersectsGround,
                                                  eclipsedDoubleScatteringTextureSize.st);
    const float cosSZACoord=unitRangeToTexCoord(cosSZAToUnitRangeTexCoord(cosSunZenithAngle), eclipsedDoubleScatteringTextureSize[2]);
    const vec3 texCoords=vec3(coords2d, cosSZACoord);

    const vec4 upper=texture(texUpper, texCoords);
    const vec4 lower=texture(texLower, texCoords);

    return mix(lower,upper,eclipsedDoubleScatteringAltitudeAlphaUpper);
}

LightPollutionTexVars scatteringTexIndicesToLightPollutionTexVars(const vec2 texIndices)
{
    const vec2 indexMax=lightPollutionTextureSize-vec2(1);

    const float altitudeURCoord = texIndices[1] / (indexMax[1]-1);
    const float distToHorizon = altitudeURCoord*LENGTH_OF_HORIZ_RAY_FROM_GROUND_TO_TOA;
    // Rounding errors can result in altitude>max, breaking the code after this calculation, so we have to clamp.
    const float altitude=clampAltitude(sqrt(sqr(distToHorizon)+sqr(earthRadius))-earthRadius);

    const bool viewRayIntersectsGround = texIndices[0] < indexMax[0]/2;
    const float cosViewZenithAngleCoord = viewRayIntersectsGround ?
                                   1-2*texIndices[0]/(indexMax[0]-1) :
                                   2*(texIndices[0]-1)/(indexMax[0]-1)-1;
    // ------------------------------------
    float cosViewZenithAngle;
    if(viewRayIntersectsGround)
    {
        const float distMin=altitude;
        const float distMax=distToHorizon;
        const float distToGround=cosViewZenithAngleCoord*(distMax-distMin)+distMin;
        cosViewZenithAngle = distToGround==0 ? -1 :
            clampCosine(-(sqr(distToHorizon)+sqr(distToGround)) / (2*distToGround*(altitude+earthRadius)));
    }
    else
    {
        const float distMin=atmosphereHeight-altitude;
        const float distMax=distToHorizon+LENGTH_OF_HORIZ_RAY_FROM_GROUND_TO_TOA;
        const float distToTopAtmoBorder=cosViewZenithAngleCoord*(distMax-distMin)+distMin;
        cosViewZenithAngle = distToTopAtmoBorder==0 ? 1 :
            clampCosine((sqr(LENGTH_OF_HORIZ_RAY_FROM_GROUND_TO_TOA)-sqr(distToHorizon)-sqr(distToTopAtmoBorder)) /
                        (2*distToTopAtmoBorder*(altitude+earthRadius)));
    }

    return LightPollutionTexVars(altitude, cosViewZenithAngle, viewRayIntersectsGround);
}

LightPollution2DCoords lightPollutionTexVarsTo2DCoords(const float altitude, const float cosViewZenithAngle, const bool viewRayIntersectsGround)
{
    const float r=earthRadius+altitude;

    const float distToHorizon = sqrt(sqr(altitude)+2*altitude*earthRadius);

    // ------------------------------------
    float cosVZACoord; // Coordinate for cos(viewZenithAngle)
    const float rCvza=r*cosViewZenithAngle;
    // Discriminant of the quadratic equation for the intersections of the ray (altitiude, cosViewZenithAngle) with the ground.
    const float discriminant=sqr(rCvza)-sqr(r)+sqr(earthRadius);
    if(viewRayIntersectsGround)
    {
        // Distance from camera to the ground along the view ray (altitude, cosViewZenithAngle)
        const float distToGround = -rCvza-safeSqrt(discriminant);
        // Minimum possible value of distToGround
        const float distMin = altitude;
        // Maximum possible value of distToGround
        const float distMax = distToHorizon;
        cosVZACoord = distMax==distMin ? 0. : (distToGround-distMin)/(distMax-distMin);
    }
    else
    {
        // Distance from camera to the atmosphere border along the view ray (altitude, cosViewZenithAngle)
        // sqr(LENGTH_OF_HORIZ_RAY_FROM_GROUND_TO_TOA) added to sqr(earthRadius) term in discriminant changes
        // sqr(earthRadius) to sqr(earthRadius+atmosphereHeight), so that we target the top atmosphere boundary instead of bottom.
        const float distToTopAtmoBorder = -rCvza+safeSqrt(discriminant+sqr(LENGTH_OF_HORIZ_RAY_FROM_GROUND_TO_TOA));
        const float distMin = atmosphereHeight-altitude;
        const float distMax = distToHorizon+LENGTH_OF_HORIZ_RAY_FROM_GROUND_TO_TOA;
        cosVZACoord = distMax==distMin ? 0. : (distToTopAtmoBorder-distMin)/(distMax-distMin);
    }

    // ------------------------------------
    const float altCoord = distToHorizon / LENGTH_OF_HORIZ_RAY_FROM_GROUND_TO_TOA;

    return LightPollution2DCoords(cosVZACoord, altCoord);
}

vec2 lightPollutionTexVarsToTexCoords(const float altitude, const float cosViewZenithAngle, const bool viewRayIntersectsGround)
{
    const LightPollution2DCoords coords = lightPollutionTexVarsTo2DCoords(altitude, cosViewZenithAngle, viewRayIntersectsGround);
    const vec2 texSize = lightPollutionTextureSize;
    const float cosVZAtc = viewRayIntersectsGround ?
                            // Coordinate is in ~[0,0.5]
                            0.5-0.5*unitRangeToTexCoord(coords.cosViewZenithAngle, texSize[0]/2) :
                            // Coordinate is in ~[0.5,1]
                            0.5+0.5*unitRangeToTexCoord(coords.cosViewZenithAngle, texSize[0]/2);
    const float altitudeTC = unitRangeToTexCoord(coords.altitude, texSize[1]);
    return vec2(cosVZAtc, altitudeTC);
}
